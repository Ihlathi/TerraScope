// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  customFieldInches,
  customFieldPixels,
  normalizedOnScene,
  parseCustomEnvironment,
  sceneBounds,
  toCenterFrame
} from "./CustomEnvironment.ts";

test("size and origin define the rectangle from the minimum corner", () => {
  const env = parseCustomEnvironment(4, 2, 1, -1);
  assert.ok(env);
  assert.deepEqual(sceneBounds(env), {
    minX: 1,
    minY: -1,
    maxX: 5,
    maxY: 1,
    centerX: 3,
    centerY: 0
  });
  assert.deepEqual(normalizedOnScene(env, 1, -1), { u: 0, v: 0 });
  assert.deepEqual(normalizedOnScene(env, 5, 1), { u: 1, v: 1 });
  assert.deepEqual(normalizedOnScene(env, 3, 0), { u: 0.5, v: 0.5 });
});

test("center frame puts the rectangle center at the origin the 2D view uses", () => {
  const env = parseCustomEnvironment(4, 2, 1, -1);
  assert.ok(env);
  assert.deepEqual(toCenterFrame(env, [3, 0]), [0, 0]);
  assert.deepEqual(toCenterFrame(env, [1, -1]), [-2, -1]);
  assert.deepEqual(toCenterFrame(env, [5, 1]), [2, 1]);
});

test("an origin at the center leaves world (0, 0) in the middle", () => {
  const env = parseCustomEnvironment(10, 6, -5, -3);
  assert.ok(env);
  const bounds = sceneBounds(env);
  assert.equal(bounds.centerX, 0);
  assert.equal(bounds.centerY, 0);
  assert.equal(bounds.minX, -5);
  assert.equal(bounds.maxY, 3);
  assert.deepEqual(toCenterFrame(env, [0, 0]), [0, 0]);
});

test("rejects a non-positive or non-finite size", () => {
  assert.equal(parseCustomEnvironment(0, 1, 0, 0), null);
  assert.equal(parseCustomEnvironment(-4, 2, 0, 0), null);
  assert.equal(parseCustomEnvironment(Number.NaN, 2, 0, 0), null);
  assert.equal(parseCustomEnvironment(4, Number.POSITIVE_INFINITY, 0, 0), null);
  assert.equal(parseCustomEnvironment(4, 2, Number.NaN, 0), null);
});

test("pixel and inch size follow length and width, not a bundled field", () => {
  const env = parseCustomEnvironment(10, 5, 0, 0);
  assert.ok(env);
  assert.deepEqual(customFieldPixels(env), { width: 1000, height: 500 });
  assert.equal(customFieldInches(env).widthInches, 10 / 0.0254);
  assert.equal(customFieldInches(env).heightInches, 5 / 0.0254);
  assert.notEqual(customFieldInches(env).widthInches, 54 * 12);
  assert.notEqual(customFieldInches(env).heightInches, 27 * 12);
});
