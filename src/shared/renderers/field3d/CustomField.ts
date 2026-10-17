// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import * as THREE from "three";
import { CustomEnvironment, sceneBounds } from "../../CustomEnvironment";
import makeAxesTemplate from "./AxesTemplate";

export default function makeCustomField(
  env: CustomEnvironment,
  materialSpecular: THREE.Color,
  materialShininess: number
): THREE.Object3D {
  const bounds = sceneBounds(env);
  const field = new THREE.Group();

  const carpet = new THREE.Mesh(
    new THREE.PlaneGeometry(env.lengthMeters, env.widthMeters),
    new THREE.MeshPhongMaterial({ color: 0x9a9a9a, side: THREE.DoubleSide })
  );
  carpet.name = "carpet";
  carpet.position.set(bounds.centerX, bounds.centerY, 0);
  field.add(carpet);

  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(bounds.minX, bounds.minY, 0.01),
      new THREE.Vector3(bounds.maxX, bounds.minY, 0.01),
      new THREE.Vector3(bounds.maxX, bounds.maxY, 0.01),
      new THREE.Vector3(bounds.minX, bounds.maxY, 0.01),
      new THREE.Vector3(bounds.minX, bounds.minY, 0.01)
    ]),
    new THREE.LineBasicMaterial({ color: 0x222222 })
  );
  field.add(outline);

  const axes = makeAxesTemplate(materialSpecular, materialShininess);
  axes.position.set(0, 0, 0.02);
  field.add(axes);

  return field;
}
