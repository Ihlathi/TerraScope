// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import Log from "../log/Log";
import LoggableType from "../log/LoggableType";
import { RecordingSample } from "./RecordingWriter";

test("capture preserves repeated, backdated and replaced samples before in-memory compression and trimming", () => {
  const log = new Log();
  const samples: RecordingSample[] = [];
  const unsubscribe = log.addSampleListener((sample) => samples.push(sample));
  log.putNumber("voltage", 1.000001, 12);
  log.putNumber("voltage", 2.000002, 12);
  log.putNumber("voltage", 1.500003, 11);
  log.putNumber("voltage", 1.500003, 10);
  log.clearBeforeTime(4);
  unsubscribe();
  log.putNumber("voltage", 5, 9);
  assert.deepEqual(
    samples.map(({ timestamp, value }) => [timestamp, value]),
    [
      [1.000001, 12],
      [2.000002, 12],
      [1.500003, 11],
      [1.500003, 10]
    ]
  );
  assert(log.getNumber("voltage", 0, Infinity)!.timestamps.every((time) => time >= 4));
});

test("capture owns mutable values and includes array children, field metadata and original clock seconds", () => {
  const log = new Log();
  const samples: RecordingSample[] = [];
  log.createBlankField("array", LoggableType.NumberArray);
  log.setWpilibType("array", "double[]");
  log.setMetadataString("array", '{"unit":"V"}');
  log.addSampleListener((sample) => samples.push(sample));
  const numbers = [1, 2];
  log.putNumberArray(
    "array",
    {
      source: { seconds: 2, domain: { kind: "clock", id: "sensor" } },
      display: { seconds: 20, domain: { kind: "log" } }
    },
    numbers
  );
  numbers[0] = 99;
  const bytes = new Uint8Array([3, 4]);
  log.putRaw("raw", 3, bytes);
  bytes[0] = 99;
  assert.deepEqual(
    samples.find((sample) => sample.key === "array"),
    {
      key: "array",
      type: LoggableType.NumberArray,
      timestamp: 2,
      value: [1, 2],
      wpilibType: "double[]",
      metadata: '{"unit":"V"}'
    }
  );
  assert.equal(samples.find((sample) => sample.key === "array/0")?.value, 1);
  assert.equal(samples.find((sample) => sample.key === "array/length")?.value, 2);
  assert.deepEqual(samples.find((sample) => sample.key === "raw")?.value, new Uint8Array([3, 4]));
});

test("capture rejects type conflicts exactly as the live log does", () => {
  const log = new Log();
  const samples: RecordingSample[] = [];
  log.addSampleListener((sample) => samples.push(sample));
  log.putNumber("field", 1, 2);
  log.putString("field", 2, "conflict");
  assert.equal(samples.length, 1);
  assert.equal(samples[0].value, 2);
});

test("capture also follows writes to fields restored from worker serialization", () => {
  const original = new Log();
  original.putNumber("field", 1, 1);
  const restored = Log.fromSerialized(original.toSerialized());
  const samples: RecordingSample[] = [];
  restored.addSampleListener((sample) => samples.push(sample));
  restored.putNumber("field", 2, 2);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].timestamp, 2);
  assert.equal(samples[0].value, 2);
});
