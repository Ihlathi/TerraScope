// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import descriptor from "protobufjs/ext/descriptor";
import Log from "./Log";
import {
  ConvertedTimestamp,
  DomainTimestamp,
  LOG_CLOCK,
  RECEIVE_CLOCK,
  TimestampDomain,
  convertTimestamp
} from "./LogTimestamp";

const sensor: TimestampDomain = { kind: "clock", id: "camera" };
function stamp(display: number, seconds = display + 100, domain = sensor): ConvertedTimestamp {
  return { source: { seconds, domain }, display: { seconds: display, domain: LOG_CLOCK } };
}
function sources(log: Log, key = "value"): DomainTimestamp[] | undefined {
  return log.getTimestampSources(key, -Infinity, Infinity);
}

test("legacy numeric timestamps and serialized logs keep the same display coordinates", () => {
  const log = new Log();
  log.putNumber("value", 1.25, 4);
  log.putNumber("value", 2.5, 5);
  const serialized = log.toSerialized();
  delete serialized.displayClock;
  delete serialized.fields.value.sourceTimestamps;
  const restored = Log.fromSerialized(serialized);
  assert.deepEqual(restored.getDisplayClock(), LOG_CLOCK);
  assert.deepEqual(restored.getNumber("value", -Infinity, Infinity), { timestamps: [1.25, 2.5], values: [4, 5] });
  assert.deepEqual(sources(restored), [
    { seconds: 1.25, domain: LOG_CLOCK },
    { seconds: 2.5, domain: LOG_CLOCK }
  ]);
});

test("receive, log and named clock timestamps retain their domain", () => {
  for (const domain of [LOG_CLOCK, RECEIVE_CLOCK, sensor]) {
    const log = new Log(true, domain);
    log.putNumber("value", { seconds: 3, domain }, 4);
    assert.deepEqual(log.getDisplayClock(), domain);
    assert.deepEqual(log.getNumber("value", -Infinity, Infinity), { timestamps: [3], values: [4] });
    assert.deepEqual(sources(Log.fromSerialized(structuredClone(log.toSerialized()))), [{ seconds: 3, domain }]);
  }
});

test("display clock ownership does not depend on mutable caller objects", () => {
  const domain: { kind: "clock"; id: string } = { kind: "clock", id: "camera" };
  const log = new Log(true, domain);
  domain.id = "other";
  assert.deepEqual(log.getDisplayClock(), sensor);
  const returned = log.getDisplayClock();
  assert.notEqual(returned, domain);
});

test("unrelated clocks require an explicit conversion before insertion", () => {
  const log = new Log();
  assert.throws(() => log.putNumber("value", { seconds: 100, domain: sensor }, 4), /explicit conversion/);
  assert.throws(
    () => log.putTranslationArray("invalid", { seconds: 100, domain: sensor }, [[1, 2]]),
    /explicit conversion/
  );
  assert.throws(
    () => log.putUnknownStruct("invalid", { seconds: 100, domain: sensor }, [1, "two"]),
    /explicit conversion/
  );
  assert.deepEqual(log.getFieldKeys(), []);
  const input = { seconds: 101, domain: sensor };
  log.putNumber("value", convertTimestamp(input, { from: sensor, to: LOG_CLOCK, offsetSeconds: -100 }), 4);
  log.putNumber("value", stamp(2, 200, RECEIVE_CLOCK), 5);
  assert.deepEqual(log.getNumber("value", -Infinity, Infinity), { timestamps: [1, 2], values: [4, 5] });
  assert.deepEqual(sources(log), [input, { seconds: 200, domain: RECEIVE_CLOCK }]);
  assert.throws(
    () => convertTimestamp(input, { from: RECEIVE_CLOCK, to: LOG_CLOCK, offsetSeconds: 0 }),
    /source clock/
  );
});

test("timestamp provenance follows insertion, duplicate replacement, both compression directions and trimming", () => {
  const log = new Log();
  log.putNumber("value", stamp(2), 20);
  log.putNumber("value", stamp(1), 10);
  log.putNumber("value", stamp(3), 20);
  assert.deepEqual(sources(log), [stamp(1).source, stamp(2).source]);
  log.putNumber("value", stamp(1.5, 150, RECEIVE_CLOCK), 20);
  assert.deepEqual(sources(log), [stamp(1).source, stamp(1.5, 150, RECEIVE_CLOCK).source]);
  log.putNumber("value", stamp(1.5, 250), 30);
  log.putNumber("value", 0, 0);
  assert.deepEqual(log.getNumber("value", -Infinity, Infinity), { timestamps: [0, 1, 1.5], values: [0, 10, 30] });
  assert.deepEqual(sources(log), [{ seconds: 0, domain: LOG_CLOCK }, stamp(1).source, stamp(1.5, 250).source]);
  log.clearBeforeTime(1.25);
  assert.deepEqual(log.getNumber("value", -Infinity, Infinity), { timestamps: [1.25, 1.5], values: [10, 30] });
  assert.deepEqual(sources(log), [stamp(1).source, stamp(1.5, 250).source]);
  assert.deepEqual(log.getTimestampSources("value", 1.5, 1.5), [stamp(1.5, 250).source]);
  assert.deepEqual(sources(Log.fromSerialized(structuredClone(log.toSerialized()))), sources(log));
});

test("structured children and queued schema decodes keep their original timestamp", () => {
  const log = new Log();
  const time = stamp(1);
  log.putJSON("json", time, '{"x":2,"array":[1,2]}');
  log.putBooleanArray("booleans", time, [true]);
  log.putStringArray("strings", time, ["one"]);
  log.putPose("pose", time, { translation: [1, 2], rotation: 3 });
  log.putTranslationArray("translations", time, [[1, 2]]);
  for (const key of [
    "json",
    "json/x",
    "json/array",
    "json/array/0",
    "json/array/length",
    "booleans",
    "booleans/0",
    "strings/0",
    "pose/translation/x",
    "translations/0/x"
  ]) {
    assert.deepEqual(sources(log, key), [time.source], key);
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, 12.5, true);
  log.putStruct("queued", time, bytes, "Reading", false);
  const restored = Log.fromSerialized(structuredClone(log.toSerialized()));
  restored.putRaw("/.schema/struct:Reading", 0, new TextEncoder().encode("double x;"));
  assert.deepEqual(restored.getNumber("queued/x", -Infinity, Infinity), { timestamps: [1], values: [12.5] });
  assert.deepEqual(sources(restored, "queued/x"), [time.source]);
});

test("merge alignment shifts display coordinates while retaining explicit originals", () => {
  const target = new Log();
  target.putBoolean("/DriverStation/Enabled", 2, true);
  const source = new Log();
  source.putBoolean("/DriverStation/Enabled", stamp(10), true);
  source.putNumber("value", stamp(11), 3);
  assert.equal(target.mergeWith(source, "/Log1"), -8);
  assert.deepEqual(target.getNumber("/Log1/value", -Infinity, Infinity), { timestamps: [3], values: [3] });
  assert.deepEqual(sources(target, "/Log1/value"), [stamp(11).source]);
  assert.deepEqual(source.getNumber("value", -Infinity, Infinity)?.timestamps, [11]);
  const named = new Log(true, sensor);
  named.putNumber("value", { seconds: 5, domain: sensor }, 2);
  const empty = new Log();
  empty.mergeWith(named);
  assert.deepEqual(empty.getDisplayClock(), sensor);
  assert.equal(empty.mergeWith(new Log()), 0);
  assert.deepEqual(empty.getDisplayClock(), sensor);
  assert.deepEqual(sources(empty), [{ seconds: 5, domain: sensor }]);
  assert.throws(() => target.mergeWith(named), /different display clocks/);
});

test("queued decodes retain their insertion timestamp when the caller changes its stamp", () => {
  const log = new Log();
  const time = {
    source: { seconds: 101, domain: { kind: "clock" as const, id: "camera" } },
    display: { seconds: 1, domain: { kind: "log" as const } }
  };
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, 12.5, true);
  log.putStruct("queued", time, bytes, "Reading", false);
  log.putProto("proto", time, Uint8Array.of(8, 7), "test.Reading");
  time.display.seconds = 2;
  time.source.seconds = 202;
  time.source.domain.id = "other";
  log.putRaw("/.schema/struct:Reading", 0, new TextEncoder().encode("double x;"));
  const schema = descriptor.FileDescriptorProto.encode({
    name: "reading.proto",
    package: "test",
    messageType: [{ name: "Reading", field: [{ name: "value", number: 1, label: 1, type: 5 }] }]
  }).finish();
  log.putProto("schema", 0, schema, "FileDescriptorProto");
  for (const key of ["queued", "queued/x", "proto", "proto/value"]) {
    assert.deepEqual(log.getRange(key, -Infinity, Infinity)?.timestamps, [1], key);
    assert.deepEqual(sources(log, key), [{ seconds: 101, domain: sensor }], key);
  }
  assert.deepEqual(log.getNumber("proto/value", -Infinity, Infinity)?.values, [7]);

  const clock = { kind: "clock" as const, id: "camera" };
  const named = new Log(true, clock);
  const direct = { seconds: 3, domain: clock };
  named.putStruct("queued", direct, bytes, "Reading", false);
  direct.seconds = 4;
  clock.id = "other";
  named.putRaw("/.schema/struct:Reading", 0, new TextEncoder().encode("double x;"));
  assert.deepEqual(named.getNumber("queued/x", -Infinity, Infinity)?.timestamps, [3]);
  assert.deepEqual(sources(named, "queued/x"), [{ seconds: 3, domain: sensor }]);
});

test("provenance uses the same samples as range queries after an exact-cutoff trim", () => {
  const log = new Log();
  log.putNumber("value", stamp(1), 1);
  log.putNumber("value", stamp(2), 2);
  log.putNumber("value", stamp(3), 3);
  log.clearBeforeTime(2);
  assert.deepEqual(log.getNumber("value", -Infinity, Infinity), { timestamps: [2, 2, 3], values: [1, 2, 3] });
  assert.deepEqual(sources(log), [stamp(1).source, stamp(2).source, stamp(3).source]);
  assert.deepEqual(log.getNumber("value", 2.5, Infinity), { timestamps: [2, 3], values: [2, 3] });
  assert.deepEqual(log.getTimestampSources("value", 2.5, Infinity), [stamp(2).source, stamp(3).source]);
});
