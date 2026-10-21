// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import LiveRecordingManager from "../main/electron/LiveRecordingManager";
import LoggableType from "../shared/log/LoggableType";
import {
  RecordingSample,
  RecordingStatus,
  RecordingWriter,
  recordingSampleSize
} from "../shared/recording/RecordingWriter";
import LiveRecording from "./LiveRecording";

const sample: RecordingSample = {
  key: "/Live1/NT:/Voltage",
  type: LoggableType.Number,
  timestamp: 1.234567,
  value: 12.5,
  wpilibType: "double",
  metadata: ""
};

function fixture(limit?: number) {
  let listener: ((sample: RecordingSample) => void) | null = null;
  const messages: { name: string; data: any }[] = [];
  const recording = new LiveRecording(
    {
      startRecording: (next) => {
        listener = next;
      },
      stopRecording: () => {
        listener = null;
      }
    },
    (name, data) => messages.push({ name, data }),
    () => {},
    limit,
    0
  );
  return { recording, messages, emit: (value = sample) => listener?.(value), listening: () => listener !== null };
}

test("stop drains accepted samples after acknowledgments and detaches the live source", async () => {
  const { recording, messages, emit, listening } = fixture();
  recording.start();
  recording.handleMessage("recording-ready", { id: 1, path: "/tmp/session.wpilog" });
  emit();
  emit({ ...sample, timestamp: 2 });
  const stopped = recording.stop();
  assert.equal(listening(), false);
  emit({ ...sample, timestamp: 3 });
  assert.equal(messages.filter((message) => message.name === "recording-batch").length, 1);
  assert.equal(
    messages.some((message) => message.name === "recording-stop"),
    false
  );
  recording.handleMessage("recording-ack", { id: 1, batch: 1 });
  assert.equal(messages.filter((message) => message.name === "recording-batch").length, 2);
  recording.handleMessage("recording-ack", { id: 1, batch: 2 });
  assert.equal(messages.at(-1)?.name, "recording-stop");
  assert.deepEqual(
    messages
      .filter((message) => message.name === "recording-batch")
      .flatMap((message) => message.data.samples)
      .map((value) => value.timestamp),
    [1.234567, 2]
  );
  recording.handleMessage("recording-status", {
    id: 1,
    status: { kind: "stopped", reason: "manual", path: "/tmp/session.wpilog", bytesWritten: 100, message: "Saved" }
  });
  await stopped;
  assert.equal(recording.getState().kind, "stopped");
});

test("restart ignores an old generation's acknowledgments and terminal status", () => {
  const { recording, messages, emit } = fixture();
  recording.start();
  recording.handleMessage("recording-status", { id: 1, status: { kind: "idle", path: "", bytesWritten: 0 } });
  recording.start();
  recording.handleMessage("recording-ready", { id: 2, path: "second.wpilog" });
  emit();
  emit({ ...sample, timestamp: 2 });
  recording.handleMessage("recording-ack", { id: 1, batch: 1 });
  recording.handleMessage("recording-status", { id: 1, status: { kind: "idle", path: "", bytesWritten: 0 } });
  assert.equal(recording.getState().kind, "recording");
  assert.equal(messages.filter((message) => message.name === "recording-batch").length, 1);
  recording.handleMessage("recording-ack", { id: 2, batch: 1 });
  assert.equal(messages.filter((message) => message.name === "recording-batch").length, 2);
});

test("a stalled writer stops capture at the pending byte limit and preserves its accepted samples", async () => {
  const { recording, messages, emit, listening } = fixture(recordingSampleSize(sample));
  recording.start();
  recording.handleMessage("recording-ready", { id: 1, path: "bounded.wpilog" });
  emit();
  emit({ ...sample, timestamp: 2 });
  emit({ ...sample, timestamp: 3 });
  assert.equal(recording.getState().kind, "stopping");
  assert.equal(listening(), false);
  assert.match(recording.getState().message, /storage could not keep up/);
  recording.handleMessage("recording-ack", { id: 1, batch: 1 });
  const batches = messages.filter((message) => message.name === "recording-batch");
  assert.deepEqual(
    batches.flatMap((message) => message.data.samples).map((value) => value.timestamp),
    [1.234567, 2]
  );
  recording.handleMessage("recording-ack", { id: 1, batch: 2 });
  recording.handleMessage("recording-status", {
    id: 1,
    status: {
      kind: "stopped",
      reason: "low-disk",
      path: "bounded.wpilog",
      bytesWritten: 10,
      message: "Disk space is low"
    }
  });
  assert.equal(recording.getState().message, "Disk space is low");
});

test("stop during the save dialog completes and ignores a late ready message", async () => {
  const { recording, messages, listening } = fixture();
  recording.start();
  const stopped = recording.stop();
  assert.equal(messages.at(-1)?.name, "recording-stop");
  recording.handleMessage("recording-status", { id: 1, status: { kind: "idle", path: "", bytesWritten: 0 } });
  await stopped;
  recording.handleMessage("recording-ready", { id: 1, path: "late.wpilog" });
  assert.equal(recording.getState().kind, "idle");
  assert.equal(listening(), false);
});

test("main cancellation before the save dialog returns never creates a writer", async () => {
  let choose!: (path: string) => void;
  const messages: { name: string; data: any }[] = [];
  let created = false;
  let finished = 0;
  const manager = new LiveRecordingManager(
    1,
    () =>
      new Promise((resolve) => {
        choose = resolve;
      }),
    (name, data) => messages.push({ name, data }),
    () => finished++,
    () => {
      created = true;
      throw new Error("Must not open a file");
    }
  );
  const started = manager.start();
  await manager.stop();
  choose("late.wpilog");
  await started;
  assert.equal(created, false);
  assert.equal(finished, 1);
  assert.deepEqual(
    messages.map((message) => message.name),
    ["recording-status"]
  );
  assert.equal(messages[0].data.status.kind, "idle");
});

test("main acknowledges a batch only after the writer has accepted it", async () => {
  const messages: { name: string; data: any }[] = [];
  let accept!: () => void;
  let onStatus!: (status: RecordingStatus) => void;
  let status: RecordingStatus = { kind: "recording", path: "session.wpilog", bytesWritten: 0 };
  const writer: RecordingWriter = {
    start: async () => {},
    write: async (samples) => {
      assert.deepEqual(samples, [sample]);
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
    },
    stop: async () => {
      status = { kind: "stopped", reason: "manual", path: "session.wpilog", bytesWritten: 42, message: "Saved" };
      onStatus(status);
    },
    getStatus: () => status
  };
  const manager = new LiveRecordingManager(
    1,
    async () => "session.wpilog",
    (name, data) => messages.push({ name, data }),
    () => {},
    (_, callback) => {
      onStatus = callback;
      return writer;
    }
  );
  await manager.start();
  const writing = manager.write(1, [sample]);
  assert.equal(
    messages.some((message) => message.name === "recording-ack"),
    false
  );
  accept();
  await writing;
  assert.equal(messages.at(-1)?.name, "recording-ack");
  await manager.stop();
  assert.equal(messages.at(-1)?.data.status.kind, "stopped");
});

test("reload shutdown drains a write and reports one terminal failure", async () => {
  const messages: { name: string; data: any }[] = [];
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  let onStatus!: (status: RecordingStatus) => void;
  let finished = 0;
  let status: RecordingStatus = { kind: "recording", path: "session.wpilog", bytesWritten: 0 };
  const writer: RecordingWriter = {
    start: async () => {},
    write: async () => {
      await accepted;
    },
    stop: async () => {
      await accepted;
      status = { kind: "stopped", reason: "manual", path: "session.wpilog", bytesWritten: 42, message: "Saved" };
      onStatus(status);
    },
    getStatus: () => status
  };
  const manager = new LiveRecordingManager(
    1,
    async () => "session.wpilog",
    (name, data) => messages.push({ name, data }),
    () => finished++,
    (_, callback) => {
      onStatus = callback;
      return writer;
    }
  );
  await manager.start();
  const writing = manager.write(1, [sample]);
  const aborted = manager.abort("Recording stopped because the live view reloaded.");
  assert.equal(finished, 0);
  accept();
  await Promise.all([writing, aborted]);
  assert.equal(finished, 1);
  assert.equal(
    messages.some((message) => message.name === "recording-ack"),
    false
  );
  assert.equal(messages.at(-1)?.data.status.kind, "error");
  assert.match(messages.at(-1)?.data.status.message, /reloaded/);
});

test("automatic writer shutdown detaches capture and does not flush pending samples after an acknowledgment", async () => {
  const { recording, messages, emit, listening } = fixture();
  recording.start();
  recording.handleMessage("recording-ready", { id: 1, path: "low-disk.wpilog" });
  emit();
  emit({ ...sample, timestamp: 2 });
  recording.handleMessage("recording-status", {
    id: 1,
    status: { kind: "stopping", path: "low-disk.wpilog", bytesWritten: 42 }
  });
  assert.equal(listening(), false);
  assert.equal(recording.getState().kind, "stopping");
  emit({ ...sample, timestamp: 3 });
  recording.handleMessage("recording-ack", { id: 1, batch: 1 });
  const stopped = recording.stop();
  assert.deepEqual(
    messages.map((message) => message.name),
    ["recording-start", "recording-batch"]
  );
  recording.handleMessage("recording-status", {
    id: 1,
    status: {
      kind: "stopped",
      reason: "low-disk",
      path: "low-disk.wpilog",
      bytesWritten: 42,
      message: "Disk space is low"
    }
  });
  await stopped;
  assert.equal(recording.getState().kind, "stopped");
  assert.equal(recording.getState().message, "Disk space is low");
});

test("automatic low-disk shutdown preserves its reason when writes or batches arrive during close", async () => {
  const messages: { name: string; data: any }[] = [];
  let finishWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  let onStatus!: (status: RecordingStatus) => void;
  let writes = 0;
  let finished = 0;
  let status: RecordingStatus = { kind: "recording", path: "low-disk.wpilog", bytesWritten: 0 };
  const writer: RecordingWriter = {
    start: async () => {},
    write: async () => {
      writes++;
      await writing;
      throw new Error("Recording is not active.");
    },
    stop: async () => {
      throw new Error("The writer is already closing.");
    },
    getStatus: () => status
  };
  const manager = new LiveRecordingManager(
    1,
    async () => "low-disk.wpilog",
    (name, data) => messages.push({ name, data }),
    () => finished++,
    (_, callback) => {
      onStatus = callback;
      return writer;
    }
  );
  await manager.start();
  const batch = manager.write(1, [sample]);
  status = { kind: "stopping", path: "low-disk.wpilog", bytesWritten: 42 };
  onStatus(status);
  await manager.write(2, [{ ...sample, timestamp: 2 }]);
  finishWrite();
  await batch;
  assert.equal(writes, 1);
  assert.equal(finished, 0);
  assert.equal(
    messages.some((message) => message.name === "recording-ack"),
    false
  );
  status = {
    kind: "stopped",
    reason: "low-disk",
    path: "low-disk.wpilog",
    bytesWritten: 42,
    message: "Disk space is low"
  };
  onStatus(status);
  assert.equal(finished, 1);
  assert.deepEqual(messages.at(-1)?.data.status, status);
});
