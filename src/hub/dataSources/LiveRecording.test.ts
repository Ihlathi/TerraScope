// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import Log from "../../shared/log/Log";
import LoggableType from "../../shared/log/LoggableType";
import { RecordingSample, RecordingWriteSample } from "../../shared/recording/RecordingWriter";
import LiveRecording from "../LiveRecording";
import { LiveDataSource, LiveDataSourceStatus } from "./LiveDataSource";
import LiveSession from "./LiveSession";

class RecordingFixtureSource extends LiveDataSource {
  connect(
    address: string,
    status: (status: LiveDataSourceStatus) => void,
    output: (log: Log, time: () => number) => void
  ) {
    super.connect(address, status, output, false);
    this.replaceLog(new Log());
  }

  replaceLog(log: Log) {
    this.log = log;
  }

  getSourceLog(): Log {
    return this.log!;
  }

  emit(time: number, value: number, key = "NT:/voltage") {
    this.log!.putNumber(key, time, value);
  }
}

function session() {
  return new LiveSession(
    () => {},
    () => {},
    () => 1000
  );
}

function numeric(samples: RecordingSample[]) {
  return samples
    .filter((sample) => sample.type === LoggableType.Number)
    .map(({ key, timestamp, value }) => ({ key, timestamp, value }));
}

test("records both namespaces before display callbacks and retains samples after memory discard", () => {
  const live = session();
  const first = new RecordingFixtureSource();
  const second = new RecordingFixtureSource();
  live.attach(first, "first", true);
  live.attach(second, "second", true);
  const samples: RecordingSample[] = [];
  live.startRecording((sample) => samples.push(sample));
  first.emit(60.000001, 12);
  first.emit(60.000002, 12);
  second.emit(3600.123456, 24);
  first.getSourceLog().clearBeforeTime(100);
  first.emit(59.5, 11);
  assert.deepEqual(numeric(samples), [
    { key: "/Live1/NT:/voltage", timestamp: 60.000001, value: 12 },
    { key: "/Live1/NT:/voltage", timestamp: 60.000002, value: 12 },
    { key: "/Live2/NT:/voltage", timestamp: 3600.123456, value: 24 },
    { key: "/Live1/NT:/voltage", timestamp: 59.5, value: 11 }
  ]);
  assert.equal(first.isRecording(), true);
  assert.equal(second.isRecording(), true);
  live.stopAll();
});

test("recording follows log replacements and ignores writes from a disconnected source's old log", () => {
  const live = session();
  const first = new RecordingFixtureSource();
  const second = new RecordingFixtureSource();
  live.attach(first, "first", true);
  live.attach(second, "second", true);
  const samples: RecordingSample[] = [];
  live.startRecording((sample) => samples.push(sample));
  const oldLog = first.getSourceLog();
  first.emit(1, 10);
  first.replaceLog(new Log());
  first.emit(2, 20);
  oldLog.putNumber("NT:/voltage", 3, 99);
  live.stop("/Live1");
  first.emit(4, 99);
  second.emit(5, 30);
  assert.deepEqual(numeric(samples), [
    { key: "/Live1/NT:/voltage", timestamp: 1, value: 10 },
    { key: "/Live1/NT:/voltage", timestamp: 2, value: 20 },
    { key: "/Live2/NT:/voltage", timestamp: 5, value: 30 }
  ]);
  assert.equal(first.isRecording(), false);
  assert.equal(second.isRecording(), true);
  live.stopAll();
});

test("stop and restart exclude stopped samples and seed schemas without exporting display history", () => {
  const live = session();
  const source = new RecordingFixtureSource();
  live.attach(source, "first");
  const log = source.getSourceLog();
  log.putRaw("NT:/.schema/struct:Position", 0.5, new TextEncoder().encode("double x"));
  log.setWpilibType("NT:/.schema/struct:Position", "structschema");
  log.setMetadataString("NT:/.schema/struct:Position", '{"description":"position"}');
  source.emit(1, 99);
  const first: RecordingSample[] = [];
  live.startRecording((sample) => first.push(sample));
  source.emit(2, 12);
  live.stopRecording();
  source.emit(3, 99);
  const second: RecordingSample[] = [];
  live.startRecording((sample) => second.push(sample));
  source.emit(4, 13);
  live.stopRecording();
  assert.equal(live.isRecording(), false);
  assert.equal(source.isRecording(), false);
  assert.deepEqual(numeric(first), [{ key: "/Live1/NT:/voltage", timestamp: 2, value: 12 }]);
  assert.deepEqual(numeric(second), [{ key: "/Live1/NT:/voltage", timestamp: 4, value: 13 }]);
  for (const samples of [first, second]) {
    assert.equal(samples[0].key, "/Live1/NT:/.schema/struct:Position");
    assert.equal(samples[0].timestamp, 0.5);
    assert.equal(samples[0].wpilibType, "structschema");
    assert.equal(samples[0].metadata, '{"description":"position"}');
    assert.deepEqual(samples[0].value, new TextEncoder().encode("double x"));
  }
  live.stopAll();
});

test("adding a source during recording preserves existing recording paths and captures its first samples", () => {
  const live = session();
  const first = new RecordingFixtureSource();
  live.attach(first, "first");
  const samples: RecordingSample[] = [];
  live.startRecording((sample) => samples.push(sample));
  first.emit(1, 12);
  const second = new RecordingFixtureSource();
  live.attach(second, "second", true);
  first.emit(2, 13);
  second.emit(100, 24);
  assert.deepEqual(numeric(samples), [
    { key: "/Live1/NT:/voltage", timestamp: 1, value: 12 },
    { key: "/Live1/NT:/voltage", timestamp: 2, value: 13 },
    { key: "/Live2/NT:/voltage", timestamp: 100, value: 24 }
  ]);
  live.stopAll();
  first.emit(3, 99);
  second.emit(101, 99);
  assert.equal(samples.length, 3);
  assert.equal(live.isRecording(), false);
});

test("a source added while recording observes synchronous writes inside connect", () => {
  class ImmediateSource extends RecordingFixtureSource {
    connect(
      address: string,
      status: (status: LiveDataSourceStatus) => void,
      output: (log: Log, time: () => number) => void
    ) {
      super.connect(address, status, output);
      this.emit(10, 20, "/signal");
    }
  }
  const live = session();
  live.attach(new RecordingFixtureSource(), "first");
  const samples: RecordingSample[] = [];
  live.startRecording((sample) => samples.push(sample));
  live.attach(new ImmediateSource(), "second", true);
  assert.deepEqual(numeric(samples), [{ key: "/Live2/signal", timestamp: 10, value: 20 }]);
  live.stopAll();
});

test("recording batches resend descriptions after source log replacement and clear previous metadata", (t) => {
  const live = session();
  const source = new RecordingFixtureSource();
  live.attach(source, "first");
  t.after(() => live.stopAll());
  const batches: { batch: number; samples: RecordingWriteSample[] }[] = [];
  const recording = new LiveRecording(
    live,
    (name, data) => {
      if (name === "recording-batch") batches.push(data as (typeof batches)[number]);
    },
    () => {},
    undefined,
    0
  );
  const acknowledge = () => recording.handleMessage("recording-ack", { id: 1, batch: batches.at(-1)!.batch });
  recording.start();
  recording.handleMessage("recording-ready", { id: 1, path: "replacement.wpilog" });
  source.emit(1, 10);
  acknowledge();
  source.emit(2, 20);
  acknowledge();
  const oldLog = source.getSourceLog();
  const replacement = new Log();
  replacement.createBlankField("NT:/voltage", LoggableType.Number);
  replacement.setWpilibType("NT:/voltage", "float");
  replacement.setMetadataString("NT:/voltage", '{"unit":"V"}');
  source.replaceLog(replacement);
  oldLog.putNumber("NT:/voltage", 3, 99);
  source.emit(3, 30);
  acknowledge();
  source.emit(4, 40);
  acknowledge();
  source.replaceLog(new Log());
  source.emit(5, 50);
  const base = { key: "/Live1/NT:/voltage", type: LoggableType.Number };
  assert.deepEqual(
    batches.map(({ samples }) => samples),
    [
      [{ ...base, timestamp: 1, value: 10, wpilibType: null, metadata: "" }],
      [{ ...base, timestamp: 2, value: 20 }],
      [{ ...base, timestamp: 3, value: 30, wpilibType: "float", metadata: '{"unit":"V"}' }],
      [{ ...base, timestamp: 4, value: 40 }],
      [{ ...base, timestamp: 5, value: 50, wpilibType: null, metadata: "" }]
    ]
  );
});
