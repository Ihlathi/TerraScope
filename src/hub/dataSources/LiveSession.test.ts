// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import Log from "../../shared/log/Log";
import { LOG_CLOCK, RECEIVE_CLOCK } from "../../shared/log/LogTimestamp";
import { sourceClock } from "../../shared/log/ProjectedLogField";
import { LiveDataSource, LiveDataSourceStatus } from "./LiveDataSource";
import LiveSession from "./LiveSession";

const clock = { kind: "clock" as const, id: "nt4-server" };
class FixtureSource extends LiveDataSource {
  stopped = false;
  clockReady = true;
  connect(
    address: string,
    status: (status: LiveDataSourceStatus) => void,
    output: (log: Log, time: () => number) => void
  ) {
    super.connect(address, status, output, false);
  }
  emit(log: Log, time: number) {
    this.log = log;
    this.setStatus(LiveDataSourceStatus.Active);
    this.outputCallback!(log, () => time);
  }
  disconnect() {
    this.setStatus(LiveDataSourceStatus.Connecting);
  }
  getTime() {
    return this.clockReady ? super.getTime() : null;
  }
  active(keys: string[]) {
    return this.getSourceKeys(keys);
  }
  stop() {
    this.stopped = true;
    super.stop();
  }
}
function log(time: number, value: number, key = "NT:/voltage") {
  const result = new Log(true, clock);
  result.putNumber(key, { seconds: time, domain: clock }, value);
  return result;
}
function setup() {
  let now = 1000;
  let changes = 0;
  const session = new LiveSession(
    () => changes++,
    () => {},
    () => now
  );
  return { session, setNow: (value: number) => (now = value), changes: () => changes };
}

test("two sources with the same topic have independent namespaces and explicit clock provenance", () => {
  const { session } = setup();
  const first = new FixtureSource();
  const second = new FixtureSource();
  session.attach(first, "first", true);
  session.attach(second, "second", true);
  first.emit(log(60, 12), 60);
  second.emit(log(3600, 24), 3600);
  const display = session.getLog()!;
  assert.deepEqual(display.getDisplayClock(), RECEIVE_CLOCK);
  assert.deepEqual(display.getNumber("/Live1/NT:/voltage", -Infinity, Infinity), { timestamps: [1000], values: [12] });
  assert.deepEqual(display.getNumber("/Live2/NT:/voltage", -Infinity, Infinity), { timestamps: [1000], values: [24] });
  assert.deepEqual(display.getTimestampSources("/Live1/NT:/voltage", -Infinity, Infinity), [
    { seconds: 60, domain: { kind: "clock", id: "Live1/nt4-server" } }
  ]);
  const restored = Log.fromSerialized(structuredClone(display.toSerialized()));
  assert.deepEqual(restored.getTimestampSources("/Live2/NT:/voltage", -Infinity, Infinity), [
    { seconds: 3600, domain: { kind: "clock", id: "Live2/nt4-server" } }
  ]);
  assert.equal(restored.getNumber("/Live2/NT:/voltage", 1000, 1000)?.values[0], 24);
});

test("one disconnect cannot stop the other source's timeline or discard its history", () => {
  const { session } = setup();
  const first = new FixtureSource();
  const second = new FixtureSource();
  session.attach(first, "first", true);
  session.attach(second, "second", true);
  const firstLog = log(60, 12);
  const secondLog = log(3600, 24);
  first.emit(firstLog, 60);
  second.emit(secondLog, 3600);
  first.disconnect();
  secondLog.putNumber("NT:/voltage", { seconds: 3601, domain: clock }, 25);
  second.emit(secondLog, 3601);
  assert.equal(session.getTimeSupplier()!(), 1001);
  assert.deepEqual(session.getLog()!.getNumber("/Live2/NT:/voltage", -Infinity, Infinity)?.values, [24, 25]);
  firstLog.clearBeforeTime(500);
  assert.deepEqual(session.getLog()!.getNumber("/Live2/NT:/voltage", -Infinity, Infinity)?.timestamps, [1000, 1001]);
  assert.equal(second.stopped, false);
});

test("retained timeline suppliers survive disconnects, reconnects and stopping the session", () => {
  const { session, setNow } = setup();
  const first = new FixtureSource();
  const second = new FixtureSource();
  session.attach(first, "first", true);
  session.attach(second, "second", true);
  first.emit(log(60, 12), 60);
  second.emit(log(3600, 24), 3600);
  const previous = session.getTimeSupplier()!;
  first.disconnect();
  second.disconnect();
  assert.equal(session.getTimeSupplier(), null);
  assert.equal(previous(), 1000);

  setNow(1010);
  first.emit(log(180, 13), 180);
  const reconnected = session.getTimeSupplier()!;
  assert.equal(reconnected(), 1010);
  assert.equal(previous(), 1000);
  session.stopAll();
  assert.equal(session.getTimeSupplier(), null);
  assert.equal(previous(), 1000);
  assert.equal(reconnected(), 1010);
});

test("reconnect replaces only its namespace and invalidates equal-count timestamp caches", () => {
  const { session, setNow } = setup();
  const first = new FixtureSource();
  const second = new FixtureSource();
  session.attach(first, "first", true);
  session.attach(second, "second", true);
  first.emit(log(60, 12), 60);
  second.emit(log(3600, 24), 3600);
  const display = session.getLog()!;
  assert.deepEqual(display.getTimestamps(["/Live1/NT:/voltage", "/Live2/NT:/voltage"], "graph"), [1000]);
  first.disconnect();
  setNow(1010);
  first.emit(log(180, 13), 180);
  assert.equal(session.getLog(), display);
  assert.deepEqual(display.getTimestamps(["/Live1/NT:/voltage", "/Live2/NT:/voltage"], "graph"), [1000, 1010]);
  assert.deepEqual(display.getNumber("/Live2/NT:/voltage", -Infinity, Infinity), { timestamps: [1000], values: [24] });
  assert.deepEqual(display.getTimestampRange(), [1000, 1010]);
});

test("removal ignores late callbacks and reuses only the freed namespace", () => {
  const { session } = setup();
  const first = new FixtureSource();
  const second = new FixtureSource();
  session.attach(first, "first", true);
  session.attach(second, "second", true);
  first.emit(log(60, 12), 60);
  second.emit(log(3600, 24), 3600);
  session.stop("/Live1");
  const replacement = new FixtureSource();
  assert.equal(session.attach(replacement, "replacement", true), "/Live1");
  replacement.emit(log(90, 18), 90);
  first.emit(log(120, 999), 120);
  assert.deepEqual(session.getLog()!.getNumber("/Live1/NT:/voltage", -Infinity, Infinity)?.values, [18]);
  assert.deepEqual(session.getLog()!.getNumber("/Live2/NT:/voltage", -Infinity, Infinity)?.values, [24]);
  assert.equal(second.stopped, false);
  assert.throws(() => session.attach(new FixtureSource(), "third", true), /two/);
});

test("legacy replacement keeps original keys, clock and source log across reconnect", () => {
  const { session } = setup();
  const first = new FixtureSource();
  session.attach(first, "first");
  const original = log(60, 12);
  first.emit(original, 60);
  assert.equal(session.getLog(), original);
  assert.deepEqual(session.getLog()!.getFieldKeys(), ["NT:/voltage"]);
  assert.equal(session.getTimeSupplier()!(), 60);
  first.disconnect();
  assert.equal(session.getTimeSupplier(), null);
  const reconnect = log(180, 13);
  first.emit(reconnect, 180);
  assert.equal(session.getLog(), reconnect);
  session.stopAll();
  assert.equal(first.stopped, true);
  assert.equal(session.getTimeSupplier(), null);
});

test("adding a connection preserves existing history and maps subscriptions only to their owner", () => {
  const { session } = setup();
  const first = new FixtureSource();
  const second = new FixtureSource();
  session.attach(first, "first");
  const original = log(60, 12);
  first.emit(original, 60);
  assert.deepEqual(first.active(["NT:/voltage"]), ["NT:/voltage"]);
  session.attach(second, "second", true);
  second.emit(log(3600, 24), 3600);
  assert.deepEqual(first.active(["/Live1/NT:/voltage", "/Live2/NT:/voltage"]), ["NT:/voltage"]);
  assert.deepEqual(second.active(["/Live1/NT:/voltage", "/Live2/NT:/voltage"]), ["NT:/voltage"]);
  assert.deepEqual(session.getLog()!.getNumber("/Live1/NT:/voltage", -Infinity, Infinity)?.values, [12]);
  assert.deepEqual(original.getNumber("NT:/voltage", -Infinity, Infinity)?.timestamps, [60]);
});

test("grouped subscriptions preserve source key syntax without requiring a parent field", () => {
  const { session } = setup();
  const first = new FixtureSource();
  const second = new FixtureSource();
  session.attach(first, "first", true);
  session.attach(second, "second", true);
  first.emit(log(60, 12, "NT:/SmartDashboard/Mechanism/joint/angle"), 60);
  const other = new Log();
  other.putNumber("/Tuning/gain", 1, 2);
  second.emit(other, 1);
  assert.deepEqual(first.active(["/Live1/NT:/SmartDashboard/Mechanism", "/Live2/Tuning"]), [
    "NT:/SmartDashboard/Mechanism"
  ]);
  assert.deepEqual(second.active(["/Live1/NT:/SmartDashboard/Mechanism", "/Live2/Tuning"]), ["/Tuning"]);
});

test("initial announcements and unavailable clock sync cannot freeze the display conversion", () => {
  const { session, setNow } = setup();
  const first = new FixtureSource();
  session.attach(first, "first", true);
  first.clockReady = false;
  const samples = log(60, 12);
  first.emit(samples, 10);
  assert.equal(session.getTimeSupplier(), null);
  first.clockReady = true;
  setNow(1001);
  first.emit(samples, 61);
  assert.deepEqual(session.getLog()!.getNumber("/Live1/NT:/voltage", -Infinity, Infinity)?.timestamps, [1000]);
  assert.equal(session.getTimeSupplier()!(), 1001);
});

test("Foxglove numeric timestamps and generated children retain their source identity", () => {
  const { session } = setup();
  const nt = new FixtureSource();
  const fox = new FixtureSource();
  session.attach(nt, "nt", true);
  session.attach(fox, "fox", true);
  nt.emit(log(60, 12), 60);
  const foxLog = new Log();
  foxLog.putJSON("pose", 200, '{"x":3,"y":4}');
  fox.emit(foxLog, 200);
  const display = session.getLog()!;
  assert.equal(display.isGenerated("/Live2/pose/x"), true);
  assert.deepEqual(display.getNumber("/Live2/pose/x", -Infinity, Infinity), { timestamps: [1000], values: [3] });
  assert.deepEqual(display.getTimestampSources("/Live2/pose/x", -Infinity, Infinity), [
    { seconds: 200, domain: { kind: "clock", id: "Live2/log" } }
  ]);
  assert.deepEqual(fox.active(["/Live2/pose/x"]), ["pose/x"]);
});

test("live projection rejects a mislabeled source or display conversion before changing data", () => {
  const display = new Log(true, RECEIVE_CLOCK);
  const samples = log(60, 12);
  assert.throws(
    () =>
      display.setProjectedSources([
        {
          log: samples,
          namespace: "/Live1",
          conversion: {
            from: LOG_CLOCK,
            to: RECEIVE_CLOCK,
            offsetSeconds: 940
          }
        }
      ]),
    /explicit/
  );
  assert.throws(
    () =>
      display.setProjectedSources([
        {
          log: samples,
          namespace: "/Live1",
          conversion: {
            from: sourceClock("/Live1", clock),
            to: LOG_CLOCK,
            offsetSeconds: 940
          }
        }
      ]),
    /explicit/
  );
  assert.deepEqual(display.getFieldKeys(), []);
});
