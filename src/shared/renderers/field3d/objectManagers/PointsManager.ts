// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import * as THREE from "three";
import { Field3dRendererCommand_PointsObj } from "../../Field3dRenderer";
import ObjectManager from "../ObjectManager";

export default class PointsManager extends ObjectManager<Field3dRendererCommand_PointsObj> {
  private points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;

  constructor(
    root: THREE.Object3D,
    materialSpecular: THREE.Color,
    materialShininess: number,
    mode: "low-power" | "standard" | "cinematic",
    isXR: boolean,
    requestRender: () => void
  ) {
    super(root, materialSpecular, materialShininess, mode, isXR, requestRender);
    this.points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.045 }));
    this.root.add(this.points);
  }

  setObjectData(object: Field3dRendererCommand_PointsObj): void {
    const pose = object.pose;
    this.points.position.set(...(pose?.translation ?? [0, 0, 0]));
    const [w, x, y, z] = pose?.rotation ?? [1, 0, 0, 0];
    this.points.quaternion.set(x, y, z, w);
    this.points.visible = object.positions.length > 0;
    this.points.material.color.set(object.color);
    let position = this.points.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (position === undefined || position.array.length !== object.positions.length) {
      this.points.geometry.dispose();
      this.points.geometry = new THREE.BufferGeometry();
      position = new THREE.Float32BufferAttribute(object.positions, 3);
      this.points.geometry.setAttribute("position", position);
    } else {
      position.set(object.positions);
      position.needsUpdate = true;
    }
    this.points.geometry.computeBoundingSphere();
  }

  dispose(): void {
    this.root.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
