// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import MCAPDecoder from "./MCAPDecoder";

declare global {
  interface Window {
    preferences?: { timestamps: string };
    selection: {
      getTimelineRange(): [number, number];
      getTimelineIsMaxZoom(): boolean;
      setTimelineRange(range: [number, number], isMaxZoom: boolean): void;
    };
  }
}

function loadFixture(): Log {
  const data = new Uint8Array(readFileSync(path.join(process.cwd(), "src/hub/dataSources/mcap/fixtures/sample.mcap")));
  const log = new Log(false);
  const progress: number[] = [];
  new MCAPDecoder().decode(log, data, (value) => progress.push(value));
  assert.equal(progress.at(-1), 1);
  return log;
}

test("reads declared MCAP channels and schemas into log fields", () => {
  const log = loadFixture();

  assert.equal(log.getType("BatteryVoltage"), LoggableType.Number);
  assert.equal(log.getStructuredType("BatteryVoltage"), "number");
  assert.deepEqual(log.getRange("BatteryVoltage", -Infinity, Infinity), {
    timestamps: [1, 2],
    values: [12.4, 12.8]
  });
  const batteryMetadata = JSON.parse(log.getMetadataString("BatteryVoltage"));
  assert.equal(batteryMetadata.messageEncoding, "json");
  assert.equal(batteryMetadata.schema, "number");
  assert.equal(batteryMetadata.schemaEncoding, "jsonschema");
  assert.equal(batteryMetadata.channelMetadata.source, "fixture");

  assert.equal(log.getType("Mode"), LoggableType.String);
  assert.equal(log.getStructuredType("Mode"), "string");
  assert.deepEqual(log.getRange("Mode", -Infinity, Infinity)?.values, ["auto"]);

  assert.equal(log.getType("Enabled"), LoggableType.Boolean);
  assert.equal(log.getStructuredType("Enabled"), "boolean");
  assert.deepEqual(log.getRange("Enabled", -Infinity, Infinity)?.values, [true]);

  assert.equal(log.getType("Samples"), LoggableType.NumberArray);
  assert.equal(log.getStructuredType("Samples"), "number[]");
  assert.deepEqual(log.getRange("Samples", -Infinity, Infinity)?.values, [[1, 2, 3]]);

  assert.equal(log.getStructuredType("ExamplePose"), "ExamplePose");
  assert.equal(log.getType("ExamplePose/x"), LoggableType.Number);
  assert.equal(log.getType("ExamplePose/y"), LoggableType.Number);
  assert.deepEqual(log.getRange("ExamplePose/x", -Infinity, Infinity)?.values, [1.5]);
  assert.deepEqual(log.getRange("ExamplePose/y", -Infinity, Infinity)?.values, [2.5]);

  assert.equal(log.getType("Scene"), LoggableType.Raw);
  assert.equal(log.getStructuredType("Scene"), "foxglove.SceneUpdate");
  const scene = log.getRange("Scene", -Infinity, Infinity);
  assert.equal(scene?.values.length, 1);
  assert.deepEqual(Array.from(scene.values[0] as Uint8Array), [9, 8, 7, 6]);
  const sceneMetadata = JSON.parse(log.getMetadataString("Scene"));
  assert.equal(sceneMetadata.messageEncoding, "protobuf");
  assert.equal(sceneMetadata.schemaEncoding, "protobuf");

  assert.equal(log.getType("Latched"), LoggableType.Empty);
  assert.equal(log.getStructuredType("Latched"), "boolean");
  assert.deepEqual(log.getRange("Latched", -Infinity, Infinity)?.timestamps, []);

  const numberSchema = log.getRange("MCAP/schemas/number", -Infinity, Infinity)?.values[0];
  assert.equal(typeof numberSchema, "string");
  assert.match(numberSchema as string, /"type":"number"/);
  assert.equal(log.getStructuredType("MCAP/schemas/ExamplePose"), "ExamplePose");
  assert.equal(log.getType("MCAP/schemas/foxglove.SceneUpdate"), LoggableType.Raw);
  assert.equal(log.getStructuredType("MCAP/schemas/foxglove.SceneUpdate"), "foxglove.SceneUpdate");
  assert.equal(log.getStructuredType("MCAP/schemas/unused.Marker"), "unused.Marker");
  assert.match(log.getRange("MCAP/schemas/unused.Marker", -Infinity, Infinity)?.values[0] as string, /"id"/);
});

test("rejects a buffer that is not an MCAP file", () => {
  assert.throws(() => new MCAPDecoder().decode(new Log(false), new Uint8Array([1, 2, 3, 4]), () => {}));
});
