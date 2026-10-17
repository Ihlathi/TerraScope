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
import JSONDecoder from "./JSONDecoder";

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

function expectRecords(log: Log) {
  assert.equal(log.getField("Timestamp"), null);
  assert.equal(log.getField("timestamp"), null);
  assert.equal(log.getType("BatteryVoltage"), LoggableType.Number);
  assert.equal(log.getType("Enabled"), LoggableType.Boolean);
  assert.equal(log.getType("Mode"), LoggableType.String);
  assert.deepEqual(log.getRange("BatteryVoltage", -Infinity, Infinity), {
    timestamps: [1, 2],
    values: [12.4, 12.8]
  });
  assert.deepEqual(log.getRange("Enabled", -Infinity, Infinity)?.values, [true, false]);
  assert.deepEqual(log.getRange("Mode", -Infinity, Infinity)?.values, ["auto", "teleop"]);
  assert.equal(log.getType("pose"), LoggableType.String);
  assert.equal(log.getStructuredType("pose"), "JSON");
  assert.deepEqual(log.getRange("pose/x", -Infinity, Infinity)?.values, [1.5, 2]);
  assert.deepEqual(log.getRange("pose/y", -Infinity, Infinity)?.values, [2.5, 3]);
}

test("JSON array of timestamped objects becomes log fields", () => {
  const data = readFileSync(path.join(process.cwd(), "src/hub/dataSources/json/fixtures/sample.json"), "utf8");
  const log = new Log(false);
  const progress: number[] = [];
  new JSONDecoder().decode(log, data, (value) => progress.push(value), "json");
  assert.equal(progress.at(-1), 1);
  expectRecords(log);
  assert.throws(() => new JSONDecoder().decode(new Log(false), '[{"BatteryVoltage": 1}]', undefined, "json"));
  assert.throws(() => new JSONDecoder().decode(new Log(false), '{"Timestamp": 1}', undefined, "json"));
});

test("JSONL records use the same timestamp and fields", () => {
  const data = readFileSync(path.join(process.cwd(), "src/hub/dataSources/json/fixtures/sample.jsonl"), "utf8");
  const log = new Log(false);
  new JSONDecoder().decode(log, data, undefined, "jsonl");
  expectRecords(log);
});
