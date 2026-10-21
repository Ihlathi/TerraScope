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
import CSVDecoder from "./CSVDecoder";

declare global {
  interface Window {
    preferences?: { timestamps: string; liveDiscard?: number };
    selection: {
      getTimelineRange(): [number, number];
      getTimelineIsMaxZoom(): boolean;
      setTimelineRange(range: [number, number], isMaxZoom: boolean): void;
    };
  }
}

function decode(data: string, delimiter?: string): Log {
  const log = new Log(false);
  new CSVDecoder().decode(log, data, undefined, delimiter);
  return log;
}

test("comma-separated table and list imports are unchanged", () => {
  const table = decode('Timestamp,BatteryVoltage,Mode\n1,12.4,"auto"\n2,12.8,"teleop"\n');
  assert.equal(table.getType("BatteryVoltage"), LoggableType.Number);
  assert.deepEqual(table.getRange("BatteryVoltage", -Infinity, Infinity), {
    timestamps: [1, 2],
    values: [12.4, 12.8]
  });
  assert.deepEqual(table.getRange("Mode", -Infinity, Infinity)?.values, ["auto", "teleop"]);

  const list = decode('Timestamp,Key,Value\n1,BatteryVoltage,12.4\n1,Mode,"auto"\n');
  assert.deepEqual(list.getRange("BatteryVoltage", -Infinity, Infinity)?.values, [12.4]);
  assert.deepEqual(list.getRange("Mode", -Infinity, Infinity)?.values, ["auto"]);

  assert.throws(() => decode("Foo,Bar\n1,2\n"));
});

test("tab-separated fixture uses the same timestamp and columns", () => {
  const data = readFileSync(path.join(process.cwd(), "src/hub/dataSources/csv/fixtures/sample.tsv"), "utf8");
  const log = decode(data, "\t");

  assert.equal(log.getType("BatteryVoltage"), LoggableType.Number);
  assert.equal(log.getType("Enabled"), LoggableType.Boolean);
  assert.equal(log.getType("Mode"), LoggableType.String);
  assert.deepEqual(log.getRange("BatteryVoltage", -Infinity, Infinity), {
    timestamps: [1, 2],
    values: [12.4, 12.8]
  });
  assert.deepEqual(log.getRange("Enabled", -Infinity, Infinity)?.values, [true, false]);
  assert.deepEqual(log.getRange("Mode", -Infinity, Infinity)?.values, ["auto", "teleop"]);

  const list = decode('Timestamp\tKey\tValue\n1\tBatteryVoltage\t12.4\n1\tMode\t"auto"\n', "\t");
  assert.deepEqual(list.getRange("BatteryVoltage", -Infinity, Infinity)?.values, [12.4]);
  assert.deepEqual(list.getRange("Mode", -Infinity, Infinity)?.values, ["auto"]);
});
