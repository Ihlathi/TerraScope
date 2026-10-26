// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WPILOGDecoder, WPILOGDecoderRecord } from "../../hub/dataSources/wpilog/WPILOGDecoder";
import { WPILOGEncoder, WPILOGEncoderRecord } from "../../hub/dataSources/wpilog/WPILOGEncoder";
import LoggableType from "../log/LoggableType";
import { RecordingSample, RecordingStatus } from "./RecordingWriter";
import WPILOGRecordingWriter from "./WPILOGRecordingWriter";

function sample(key: string, timestamp: number, value: number): RecordingSample {
  return { key, timestamp, value, type: LoggableType.Number, wpilibType: null, metadata: "" };
}

async function records(file: string) {
  const decoder = new WPILOGDecoder(await readFile(file));
  assert(decoder.isValid());
  const output: WPILOGDecoderRecord[] = [];
  decoder.forEach((record) => output.push(record));
  return output;
}

const disk = { checkFreeSpace: async () => 1024 * 1024 * 1024 };

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "terrascope-recording-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "live.wpilog");
}

test("file grows during recording and existing WPILOG reader round-trips fields, exact timestamps and values", async (t) => {
  const file = await fixture(t);
  const writer = new WPILOGRecordingWriter(file, undefined, disk);
  await writer.start();
  const initialBytes = (await stat(file)).size;
  const base = { timestamp: 12.345678, wpilibType: null, metadata: '{"unit":"V"}' };
  const samples: RecordingSample[] = [
    {
      ...base,
      key: "/Live1/raw",
      type: LoggableType.Raw,
      value: new Uint8Array([0, 255, 4]),
      wpilibType: "struct:Thing"
    },
    { ...base, key: "/Live1/bool", type: LoggableType.Boolean, value: true },
    { ...base, key: "/Live1/number", type: LoggableType.Number, value: 12.5 },
    { ...base, key: "/Live1/text", type: LoggableType.String, value: "telemetry λ" },
    { ...base, key: "/Live1/bools", type: LoggableType.BooleanArray, value: [true, false] },
    { ...base, key: "/Live1/numbers", type: LoggableType.NumberArray, value: [1.5, -2] },
    { ...base, key: "/Live1/strings", type: LoggableType.StringArray, value: ["a", "λ"] },
    { ...base, key: "/Live2/number", type: LoggableType.Number, value: -3.5 },
    { ...base, key: "/Live1/integer", type: LoggableType.Number, value: -123, wpilibType: "int64" },
    { ...base, key: "/Live1/float", type: LoggableType.Number, value: 1.25, wpilibType: "float" },
    { ...base, key: "/Live1/integers", type: LoggableType.NumberArray, value: [1, -2], wpilibType: "int64[]" },
    { ...base, key: "/Live1/floats", type: LoggableType.NumberArray, value: [1.25, -2.5], wpilibType: "float[]" }
  ];
  await writer.write(samples);
  assert((await stat(file)).size > initialBytes);
  const beforeStop = await records(file);
  const definitions = new Map(
    beforeStop
      .filter((record) => record.isStart())
      .map((record) => {
        const data = record.getStartData();
        return [data.entry, data];
      })
  );
  const values = beforeStop.filter((record) => !record.isControl());
  assert.equal(values.length, samples.length);
  values.forEach((record, index) => {
    const expected = samples[index];
    assert.equal(definitions.get(record.getEntry())!.name, expected.key);
    assert.equal(definitions.get(record.getEntry())!.metadata, expected.metadata);
    assert.equal(record.getTimestamp(), 12345678);
    const decode = {
      raw: () => record.getRaw(),
      "struct:Thing": () => record.getRaw(),
      boolean: () => record.getBoolean(),
      double: () => record.getDouble(),
      string: () => record.getString(),
      "boolean[]": () => record.getBooleanArray(),
      "double[]": () => record.getDoubleArray(),
      "string[]": () => record.getStringArray(),
      int64: () => record.getInteger(),
      float: () => record.getFloat(),
      "int64[]": () => record.getIntegerArray(),
      "float[]": () => record.getFloatArray()
    };
    const type = definitions.get(record.getEntry())!.type as keyof typeof decode;
    assert.deepEqual(decode[type](), expected.value);
  });
  await writer.write(samples.map(({ wpilibType, metadata, ...value }) => value));
  await writer.stop();
  const afterStop = await records(file);
  assert.deepEqual(
    afterStop.filter((record) => record.isControl()).map((record) => record.getStartData()),
    beforeStop.filter((record) => record.isControl()).map((record) => record.getStartData())
  );
  assert.deepEqual(
    afterStop
      .filter((record) => !record.isControl())
      .map((record) => [record.getEntry(), record.getTimestamp(), record.getRaw()]),
    [...values, ...values].map((record) => [record.getEntry(), record.getTimestamp(), record.getRaw()])
  );
  assert.equal(writer.getStatus().kind, "stopped");
});

test("recording retains repeated, equal-timestamp and out-of-order records and metadata changes", async (t) => {
  const file = await fixture(t);
  const writer = new WPILOGRecordingWriter(file, undefined, disk);
  await writer.start();
  await writer.write([
    sample("field", 2, 1),
    sample("field", 3, 1),
    sample("field", 1, 4),
    { ...sample("field", 1, 5), metadata: '{"unit":"m"}' }
  ]);
  await writer.stop();
  const expected = new WPILOGEncoder("TerraScope continuous recording");
  expected.add(
    WPILOGEncoderRecord.makeControlStart(2000000, { entry: 1, name: "field", type: "double", metadata: "" })
  );
  expected.add(WPILOGEncoderRecord.makeDouble(1, 2000000, 1));
  expected.add(WPILOGEncoderRecord.makeDouble(1, 3000000, 1));
  expected.add(WPILOGEncoderRecord.makeDouble(1, 1000000, 4));
  expected.add(WPILOGEncoderRecord.makeControlSetMetadata(1000000, { entry: 1, metadata: '{"unit":"m"}' }));
  expected.add(WPILOGEncoderRecord.makeDouble(1, 1000000, 5));
  assert.deepEqual(new Uint8Array(await readFile(file)), expected.getEncoded());
  const output = await records(file);
  assert.deepEqual(
    output.filter((record) => !record.isControl()).map((record) => [record.getTimestamp(), record.getDouble()]),
    [
      [2000000, 1],
      [3000000, 1],
      [1000000, 4],
      [1000000, 5]
    ]
  );
  assert.deepEqual(output.find((record) => record.isSetMetadata())!.getSetMetadataData(), {
    entry: 1,
    metadata: '{"unit":"m"}'
  });
});

test("stop drains accepted writes, rejects later samples, and restart resets file and entries", async (t) => {
  const file = await fixture(t);
  const writer = new WPILOGRecordingWriter(file, undefined, disk);
  await writer.start();
  const first = writer.write([sample("first", 1, 1)]);
  const second = writer.write([sample("second", 2, 2)]);
  await Promise.all([writer.stop(), writer.stop(), first, second]);
  await assert.rejects(writer.write([sample("later", 3, 3)]));
  assert.equal((await records(file)).filter((record) => !record.isControl()).length, 2);
  await writer.start();
  await writer.write([sample("restart", 4, 4)]);
  await writer.stop();
  const output = await records(file);
  assert.equal(output.filter((record) => !record.isControl()).length, 1);
  assert.equal(output.find((record) => record.isStart())!.getStartData().name, "restart");
});

test("low disk before start leaves an existing destination untouched", async (t) => {
  const file = await fixture(t);
  await writeFile(file, "existing recording");
  const statuses: RecordingStatus[] = [];
  const writer = new WPILOGRecordingWriter(file, (status) => statuses.push(status), { checkFreeSpace: async () => 1 });
  await assert.rejects(writer.start());
  assert.equal(await readFile(file, "utf8"), "existing recording");
  assert.equal(statuses.at(-1)!.kind, "stopped");
  assert.equal(writer.getStatus().kind === "stopped" && (writer.getStatus() as { reason: string }).reason, "low-disk");
});

test("low disk during idle recording closes a readable file and emits the visible reason", async (t) => {
  const file = await fixture(t);
  let free = 1024 * 1024 * 1024;
  let stopped!: () => void;
  const terminal = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const statuses: RecordingStatus[] = [];
  const writer = new WPILOGRecordingWriter(
    file,
    (status) => {
      statuses.push(status);
      if (status.kind === "stopped" || status.kind === "error") stopped();
    },
    { checkFreeSpace: async () => free, checkIntervalMs: 5 }
  );
  await writer.start();
  await writer.write([sample("field", 1.234567, 5)]);
  free = 1;
  await Promise.race([
    terminal,
    delay(1000).then(() => {
      throw new Error("Low disk did not stop the idle recorder");
    })
  ]);
  const status = statuses.at(-1)!;
  assert.equal(status.kind, "stopped");
  assert(status.kind === "stopped" && status.reason === "low-disk");
  assert(status.kind === "stopped" && status.message.includes("disk space"));
  assert.equal((await records(file)).filter((record) => !record.isControl()).length, 1);
  await assert.rejects(writer.write([sample("field", 2, 6)]));
});

test("low disk before a batch stops without writing partial records", async (t) => {
  const file = await fixture(t);
  let free = 1024 * 1024 * 1024;
  const writer = new WPILOGRecordingWriter(file, undefined, { checkFreeSpace: async () => free });
  await writer.start();
  await writer.write([sample("field", 1, 1)]);
  free = 1;
  await assert.rejects(writer.write([sample("field", 2, 2)]));
  await writer.stop();
  assert.deepEqual(
    (await records(file)).filter((record) => !record.isControl()).map((record) => record.getDouble()),
    [1]
  );
});

test("bounded pending bytes stop a recording visibly instead of retaining an unbounded session", async (t) => {
  const file = await fixture(t);
  const writer = new WPILOGRecordingWriter(file, undefined, { ...disk, maxPendingBytes: 100 });
  await writer.start();
  await assert.rejects(writer.write([sample("field", 1, 1)]));
  await writer.stop();
  assert.equal(writer.getStatus().kind, "error");
  assert.equal((await records(file)).filter((record) => !record.isControl()).length, 0);
});

test("stop during start does not create an orphan open writer", async (t) => {
  const file = await fixture(t);
  let release!: (value: number) => void;
  const free = new Promise<number>((resolve) => {
    release = resolve;
  });
  const writer = new WPILOGRecordingWriter(file, undefined, { checkFreeSpace: () => free });
  const starting = writer.start();
  const stopping = writer.stop();
  release(1024 * 1024 * 1024);
  await Promise.all([starting, stopping]);
  assert.equal(writer.getStatus().kind, "stopped");
  await assert.rejects(stat(file));
});

test("redeclared types and newly added fields always use distinct WPILOG entries", async (t) => {
  const file = await fixture(t);
  const writer = new WPILOGRecordingWriter(file, undefined, disk);
  await writer.start();
  await writer.write([sample("field", 1, 1)]);
  await writer.write([
    { key: "field", type: LoggableType.String, timestamp: 2, value: "new type", wpilibType: null, metadata: "" },
    sample("other", 3, 3)
  ]);
  await writer.stop();
  const output = await records(file);
  assert.deepEqual(
    output.filter((record) => record.isStart()).map((record) => record.getStartData().entry),
    [1, 2, 3]
  );
  assert.deepEqual(
    output.filter((record) => !record.isControl()).map((record) => record.getEntry()),
    [1, 2, 3]
  );
});

test("NetworkTables integer aliases use standard WPILOG integer types", async (t) => {
  const file = await fixture(t);
  const writer = new WPILOGRecordingWriter(file, undefined, disk);
  await writer.start();
  await writer.write([
    { ...sample("integer", 1, -12), wpilibType: "int" },
    { key: "integers", type: LoggableType.NumberArray, timestamp: 2, value: [-1, 2], wpilibType: "int[]", metadata: "" }
  ]);
  await writer.stop();
  const output = await records(file);
  assert.deepEqual(
    output.filter((record) => record.isStart()).map((record) => record.getStartData().type),
    ["int64", "int64[]"]
  );
  const values = output.filter((record) => !record.isControl());
  assert.equal(values[0].getInteger(), -12);
  assert.deepEqual(values[1].getIntegerArray(), [-1, 2]);
});

test("a delayed disk check from a stopped recording cannot stop its restarted writer", async (t) => {
  const file = await fixture(t);
  let defer = false;
  let release!: (value: number) => void;
  let checking!: () => void;
  const checkStarted = new Promise<void>((resolve) => {
    checking = resolve;
  });
  const writer = new WPILOGRecordingWriter(file, undefined, {
    checkIntervalMs: 5,
    checkFreeSpace: async () => {
      if (!defer) return 1024 * 1024 * 1024;
      defer = false;
      checking();
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    }
  });
  await writer.start();
  defer = true;
  await Promise.race([
    checkStarted,
    delay(1000).then(() => {
      throw new Error("Disk check did not run");
    })
  ]);
  await writer.stop();
  await writer.start();
  release(1);
  await delay(20);
  assert.equal(writer.getStatus().kind, "recording");
  await writer.write([sample("restarted", 2, 2)]);
  await writer.stop();
  assert.equal((await records(file)).filter((record) => !record.isControl()).length, 1);
});

test("a writer requires field descriptions again after restart", async (t) => {
  const file = await fixture(t);
  const writer = new WPILOGRecordingWriter(file, undefined, disk);
  await writer.start();
  await writer.write([{ ...sample("field", 1, 1), wpilibType: "float", metadata: '{"unit":"V"}' }]);
  await writer.stop();
  await writer.start();
  const { wpilibType, metadata, ...value } = sample("field", 2, 2);
  await assert.rejects(writer.write([value]), /no description/);
  await writer.stop();
  assert.equal((await records(file)).length, 0);
});
