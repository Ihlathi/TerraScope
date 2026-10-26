// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import * as THREE from "three";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader";
import { Pose3d } from "../../../geometry";
import { resolveURDFMesh, URDFVisual } from "../../../urdf/URDF";
import { Field3dRendererCommand_URDFObj } from "../../Field3dRenderer";
import ObjectManager from "../ObjectManager";

function setPose(object: THREE.Object3D, pose: Pose3d) {
  object.position.set(...pose.translation);
  const [w, x, y, z] = pose.rotation;
  object.quaternion.set(x, y, z, w);
}

function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    geometries.add(child.geometry);
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

export default class URDFManager extends ObjectManager<Field3dRendererCommand_URDFObj> {
  private group = new THREE.Group();
  private links = new Map<string, THREE.Group>();
  private modelKey: string | null = null;
  private generation = 0;
  private diagnostics = new Set<string>();

  constructor(
    root: THREE.Object3D,
    materialSpecular: THREE.Color,
    materialShininess: number,
    mode: "low-power" | "standard" | "cinematic",
    isXR: boolean,
    requestRender: () => void
  ) {
    super(root, materialSpecular, materialShininess, mode, isXR, requestRender);
    this.root.add(this.group);
  }

  getDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  private material(visual: URDFVisual): THREE.MeshPhongMaterial {
    const [r, g, b, opacity] = visual.color;
    return new THREE.MeshPhongMaterial({
      color: new THREE.Color(r, g, b),
      opacity,
      transparent: opacity < 1,
      specular: this.materialSpecular,
      shininess: this.materialShininess
    });
  }

  private addVisual(parent: THREE.Group, visual: URDFVisual, command: Field3dRendererCommand_URDFObj) {
    const origin = new THREE.Group();
    setPose(origin, visual.origin);
    parent.add(origin);
    const geometry = visual.geometry;
    switch (geometry.type) {
      case "box":
        origin.add(new THREE.Mesh(new THREE.BoxGeometry(...geometry.size), this.material(visual)));
        break;
      case "sphere":
        origin.add(new THREE.Mesh(new THREE.SphereGeometry(geometry.radius, 24, 16), this.material(visual)));
        break;
      case "cylinder": {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(geometry.radius, geometry.radius, geometry.length, 32),
          this.material(visual)
        );
        mesh.rotation.x = Math.PI / 2;
        origin.add(mesh);
        break;
      }
      case "mesh": {
        const resolution = resolveURDFMesh(geometry.filename, command.baseUrl, command.packageRootUrl);
        if ("error" in resolution) {
          this.diagnostics.add(`URDF mesh "${geometry.filename}": ${resolution.error}`);
          return;
        }
        const url = resolution.url;
        const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
        const generation = this.generation;
        const report = (message: string) => {
          if (generation !== this.generation) return;
          this.diagnostics.add(`URDF mesh "${geometry.filename}": ${message}`);
          this.requestRender();
        };
        const manager = new THREE.LoadingManager();
        manager.onError = (resource) => report(`Could not load "${resource}".`);
        manager.setURLModifier((resource) => {
          try {
            const parsed = new URL(resource, url);
            if (["file:", "blob:", "data:"].includes(parsed.protocol)) return parsed.href;
          } catch {}
          report(`Unsupported resource "${resource}". Only local resources can be loaded.`);
          return "data:application/octet-stream,";
        });
        const attach = (object: THREE.Object3D) => {
          if (generation !== this.generation) {
            disposeObject(object);
            return;
          }
          const scaled = new THREE.Group();
          scaled.scale.set(...geometry.scale);
          scaled.add(object);
          origin.add(scaled);
          this.requestRender();
        };
        if (extension === "stl") {
          new STLLoader(manager).load(
            url,
            (meshGeometry) => attach(new THREE.Mesh(meshGeometry, this.material(visual))),
            undefined,
            () => report(`Could not load "${url}".`)
          );
        } else if (extension === "dae") {
          new THREE.FileLoader(manager).load(
            url,
            (text) => {
              if (generation !== this.generation) return;
              if (typeof text !== "string") {
                report("Expected a COLLADA XML document.");
                return;
              }
              try {
                const xml = new DOMParser().parseFromString(text, "application/xml");
                const upAxis = xml.getElementsByTagName("up_axis")[0]?.textContent?.trim();
                const collada = new ColladaLoader(manager).parse(text, new URL(".", url).href);
                // ColladaLoader converts Z-up meshes to Y-up. URDF link coordinates retain the mesh's Z-up axes.
                if (upAxis === "Z_UP") collada.scene.quaternion.identity();
                collada.scene.traverse((child) => {
                  if (!(child instanceof THREE.Mesh)) return;
                  const materials = Array.isArray(child.material) ? child.material : [child.material];
                  for (const material of materials) {
                    if ("color" in material && material.color instanceof THREE.Color) {
                      const [r, g, b] = visual.color;
                      material.color.multiply(new THREE.Color(r, g, b));
                    }
                    material.opacity *= visual.color[3];
                    material.transparent ||= material.opacity < 1;
                  }
                });
                attach(collada.scene);
              } catch (error) {
                report(error instanceof Error ? error.message : "Could not parse COLLADA mesh.");
              }
            },
            undefined,
            () => report(`Could not load "${url}".`)
          );
        } else {
          report(`Unsupported mesh format "${extension ?? "(none)"}". Use STL or DAE.`);
        }
        break;
      }
    }
  }

  setObjectData(object: Field3dRendererCommand_URDFObj): void {
    const key = JSON.stringify([object.robot, object.baseUrl, object.packageRootUrl]);
    if (key !== this.modelKey) {
      this.generation++;
      disposeObject(this.group);
      this.group.clear();
      this.links.clear();
      this.diagnostics.clear();
      this.modelKey = key;
      for (const link of object.robot.links) {
        const group = new THREE.Group();
        this.links.set(link.name, group);
        this.group.add(group);
        for (const visual of link.visuals) this.addVisual(group, visual, object);
      }
    }
    for (const link of object.links) {
      const group = this.links.get(link.name)!;
      group.visible = link.pose !== null;
      if (link.pose) setPose(group, link.pose);
    }
  }

  dispose(): void {
    this.generation++;
    this.root.remove(this.group);
    disposeObject(this.group);
    this.group.clear();
    this.links.clear();
    this.diagnostics.clear();
  }
}
