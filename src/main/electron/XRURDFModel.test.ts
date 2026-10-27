// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { Decoder, Encoder } from "@msgpack/msgpack";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Field3dRendererURDFModel } from "../../shared/renderers/Field3dRenderer";
import { parseURDF } from "../../shared/urdf/URDF";
import XRURDFModel from "./XRURDFModel";

test("XR sends each URDF model change once and replays only the current resource on connection", () => {
  const resources = new XRURDFModel();
  const robot = parseURDF('<robot name="XR"><link name="base"/></robot>');
  const model: Field3dRendererURDFModel = { id: "first", robot, baseUrl: null, packageRootUrl: null };
  const encoder = new Encoder();
  const decoder = new Decoder();
  assert.equal(resources.snapshot().value, null);
  const first = resources.update(model)!;
  assert.equal(first.type, "urdfModel");
  assert.deepEqual(decoder.decode(encoder.encode(first)), first);
  for (let i = 0; i < 30; i++) assert.equal(resources.update(model), null);
  assert.equal(resources.snapshot().value!.id, "first", "new client receives current model without requiring a change");
  assert.equal(resources.update({ ...model, id: "second" })!.value!.id, "second");
  assert.equal(resources.snapshot().value!.id, "second");
  assert.equal(resources.update(null)!.value, null);
  assert.equal(resources.update(null), null);
  resources.update(model);
  resources.clear();
  assert.equal(resources.snapshot().value, null, "server shutdown releases the model");
});
