// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { DOMParser } from "@xmldom/xmldom";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import * as THREE from "three";
import { parseURDF } from "../../../urdf/URDF";
import { createUUID } from "../../../util";
import type { Field3dRendererCommand_URDFObj, Field3dRendererURDFModel } from "../../Field3dRenderer";
import URDFManager from "./URDFManager";

const pose = { translation: [0, 0, 0], rotation: [1, 0, 0, 0] } as const;
function scene(xml: string) {
  const root = new THREE.Group();
  const manager = new URDFManager(root, new THREE.Color("white"), 30, "standard", false, () => {});
  const robot = parseURDF(xml);
  const model: Field3dRendererURDFModel = {
    id: createUUID(),
    robot,
    baseUrl: "file:///robot/robot.urdf",
    packageRootUrl: null
  };
  const command: Field3dRendererCommand_URDFObj = {
    type: "urdf",
    modelId: model.id,
    links: robot.links.map((link) => ({
      name: link.name,
      pose: { translation: [...pose.translation], rotation: [...pose.rotation] }
    }))
  };
  manager.setModel(model);
  manager.setObjectData(command);
  return { root, manager, command, model };
}
function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) result.push(child);
  });
  return result;
}

test("named materials share one instance across links and are disposed once", () => {
  const { root, manager } = scene(
    `<robot name="shared"><material name="red"><color rgba="1 0 0 1"/></material><link name="a"><visual><geometry><box size="1 1 1"/></geometry><material name="red"/></visual></link><link name="b"><visual><geometry><sphere radius="1"/></geometry><material name="red"/></visual></link><joint name="ab" type="fixed"><parent link="a"/><child link="b"/></joint></robot>`
  );
  const rendered = meshes(root);
  assert.equal(rendered.length, 2);
  assert.equal(rendered[0].material, rendered[1].material);
  let disposals = 0;
  (rendered[0].material as THREE.Material).addEventListener("dispose", () => disposals++);
  manager.dispose();
  assert.equal(disposals, 1);
});

test("cloned satellite commands update link poses without rebuilding visual resources", () => {
  const { root, manager, command, model } = scene(
    '<robot name="one"><link name="a"><visual><geometry><box size="1 1 1"/></geometry></visual></link></robot>'
  );
  const before = meshes(root)[0];
  const cloned = structuredClone(command);
  cloned.links[0].pose!.translation[2] = 3;
  Object.defineProperty(model.robot, "toJSON", {
    value: () => {
      throw new Error("Robot serialization during pose update");
    }
  });
  manager.setObjectData(cloned);
  assert.equal(meshes(root)[0], before);
  root.updateMatrixWorld(true);
  assert.equal(before.getWorldPosition(new THREE.Vector3()).z, 3);
  const next = parseURDF(
    '<robot name="two"><link name="a"><visual><geometry><sphere radius="1"/></geometry></visual></link></robot>'
  );
  const nextId = createUUID();
  manager.setModel({ ...model, id: nextId, robot: next });
  manager.setObjectData({ ...cloned, modelId: nextId });
  assert.notEqual(meshes(root)[0], before);
  manager.dispose();
});

test("COLLADA Y-up and Z-up authored vertical axes both render vertically in URDF Z-up", () => {
  const originalParser = globalThis.DOMParser;
  const originalLoad = THREE.FileLoader.prototype.load;
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
  const fixture = fs.readFileSync("src/hub/dataSources/ros2/fixtures/urdf/packages/demo/meshes/tool.dae", "utf8");
  try {
    for (const upAxis of ["Y_UP", "Z_UP"]) {
      THREE.FileLoader.prototype.load = function (_url, onLoad) {
        onLoad!(fixture.replace(/<up_axis>[^<]+<\/up_axis>/, `<up_axis>${upAxis}</up_axis>`));
        return undefined;
      };
      const { root, manager } = scene(
        '<robot name="mesh"><link name="a"><visual><geometry><mesh filename="tool.dae" scale="1 1 1"/></geometry></visual></link></robot>'
      );
      assert.deepEqual(manager.getDiagnostics(), []);
      const mesh = meshes(root)[0];
      assert(mesh, "COLLADA geometry loaded");
      assert(mesh.geometry.getAttribute("normal"), "COLLADA faces without authored normals receive lighting normals");
      root.updateMatrixWorld(true);
      const vertical = new THREE.Vector3(...((upAxis === "Y_UP" ? [0, 1, 0] : [0, 0, 1]) as [number, number, number]));
      vertical.transformDirection(mesh.matrixWorld);
      assert(vertical.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-10);
      manager.dispose();
    }
  } finally {
    globalThis.DOMParser = originalParser;
    THREE.FileLoader.prototype.load = originalLoad;
  }
});

test("X_UP COLLADA is skipped with a visible diagnostic while other visuals remain", () => {
  const originalParser = globalThis.DOMParser;
  const originalLoad = THREE.FileLoader.prototype.load;
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
  const fixture = fs.readFileSync("src/hub/dataSources/ros2/fixtures/urdf/packages/demo/meshes/tool.dae", "utf8");
  try {
    THREE.FileLoader.prototype.load = function (_url, onLoad) {
      onLoad!(fixture.replace(/<up_axis>[^<]+<\/up_axis>/, "<up_axis>X_UP</up_axis>"));
      return undefined;
    };
    const { root, manager } = scene(
      '<robot name="mesh"><link name="a"><visual><geometry><box size="1 1 1"/></geometry></visual><visual><geometry><mesh filename="tool.dae"/></geometry></visual></link></robot>'
    );
    assert.equal(meshes(root).length, 1);
    assert.match(manager.getDiagnostics().join("\n"), /Unsupported COLLADA up axis "X_UP"/);
    manager.dispose();
  } finally {
    globalThis.DOMParser = originalParser;
    THREE.FileLoader.prototype.load = originalLoad;
  }
});
