// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { McapStreamReader } from "@mcap/core";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { grabPosesAuto } from "../../../shared/geometry";
import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import { canReadAsPose } from "../../../shared/log/SemanticType";
import MCAPDecoder from "./MCAPDecoder";

const bytes = new Uint8Array(readFileSync(path.join(process.cwd(), "sampleLogs/terrascope-sample.mcap")));

function close(actual: number[], expected: number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < 1e-5, `${value} differs from ${expected[index]}`)
  );
}

function decoded(): Log {
  const log = new Log(false);
  new MCAPDecoder().decode(log, bytes, () => {});
  return log;
}

test("sample JSON poses decode into the pose readers used by both field tabs", () => {
  const log = decoded();
  for (const type of ["Pose2d", "Pose3d"]) {
    const key = "/Robot/" + type;
    assert.equal(log.getStructuredType(key), type);
    assert.ok(canReadAsPose(log.getStructuredType(key)!));
    const start = grabPosesAuto(log, key, type, 0);
    assert.equal(start.length, 1);
    close(start[0].pose.translation, [8, 4, 0]);
    close(start[0].pose.rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    const halfway = grabPosesAuto(log, key, type, 20)[0].pose;
    close(halfway.translation, [2, 4, 0]);
    close(halfway.rotation, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  }
  const ramp = grabPosesAuto(log, "/Robot/Pose3d", "Pose3d", 5)[0].pose;
  close(ramp.translation, [7.12132, 6.12132, 0.4]);
  close(ramp.rotation, [0.380771609, -0.09223405, 0.038204595, 0.919263983]);
  close(grabPosesAuto(log, "/Robot/Pose3d", "Pose3d", 10)[0].pose.translation, [5, 7, 0.8]);
  assert.equal(grabPosesAuto(log, "/Robot/Pose2d", "Pose2d", 5)[0].annotation.is2DSource, true);
  assert.equal(grabPosesAuto(log, "/Robot/Pose3d", "Pose3d", 5)[0].annotation.is2DSource, false);
});

test("sample contains forty seconds of telemetry, JSON schemas, and indexed metadata below 3 MB", () => {
  assert.ok(bytes.byteLength < 3_000_000);
  const reader = new McapStreamReader();
  reader.append(bytes);
  const topics = new Map<number, string>();
  const counts = new Map<string, number>();
  const times = new Map<string, bigint[]>();
  let hasMetadataIndex = false;
  let hasStatistics = false;
  for (let record = reader.nextRecord(); record !== undefined; record = reader.nextRecord()) {
    if (record.type === "Schema") assert.equal(record.encoding, "jsonschema");
    if (record.type === "Channel") {
      assert.equal(record.messageEncoding, "json");
      topics.set(record.id, record.topic);
    }
    if (record.type === "Message") {
      const topic = topics.get(record.channelId)!;
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
      const previous = times.get(topic) ?? [];
      previous.push(record.logTime);
      times.set(topic, previous);
    }
    if (record.type === "Metadata") {
      assert.equal(record.metadata.get("robot"), "TerraScope sample robot");
      assert.equal(record.metadata.get("wallClockStart"), "2026-01-01T12:00:00.000Z");
    }
    if (record.type === "MetadataIndex") hasMetadataIndex = true;
    if (record.type === "Statistics") {
      hasStatistics = true;
      assert.equal(record.messageStartTime, 0n);
      assert.equal(record.messageEndTime, 40_000_000_000n);
    }
  }
  assert.ok(reader.done());
  assert.ok(hasMetadataIndex);
  assert.ok(hasStatistics);
  for (const topic of ["/Robot/Pose2d", "/Robot/Pose3d"]) {
    assert.equal(counts.get(topic), 2001);
    const stamps = times.get(topic)!;
    assert.ok(stamps.every((stamp, index) => stamp === BigInt(index) * 20_000_000n));
  }
  assert.equal(counts.get("/Robot/IMU"), 4001);
  assert.ok(times.get("/Robot/IMU")!.every((stamp, index) => stamp === BigInt(index) * 10_000_000n));
});

test("sample exposes motor currents, inertial signals, boolean transitions, arrays, and irregular console lines", () => {
  const log = decoded();
  for (const motor of ["Drive/FrontLeft", "Drive/FrontRight", "Drive/RearLeft", "Drive/RearRight", "Arm"]) {
    const current = log.getRange("/Robot/" + motor + "/current", 0, 40)!;
    assert.ok(current.values.some((value) => Number(value) > 4));
    assert.equal(log.getType("/Robot/" + motor + "/voltage"), LoggableType.Number);
  }
  for (const field of ["yaw", "pitch", "roll", "accel/x", "accel/y", "accel/z", "gyro/x", "gyro/y", "gyro/z"]) {
    assert.equal(log.getType("/Robot/IMU/" + field), LoggableType.Number);
  }
  for (const field of ["Enabled", "BrakeMode", "ArmLimit"]) {
    assert.equal(log.getType("/Robot/" + field), LoggableType.Boolean);
    assert.deepEqual(new Set(log.getRange("/Robot/" + field, 0, 40)!.values), new Set([true, false]));
  }
  assert.equal(log.getType("/Robot/NumberArray"), LoggableType.NumberArray);
  const lines = log.getRange("/Robot/Console", 0, 40)!;
  assert.ok(lines.values.some((line) => String(line).includes("[WARN]")));
  assert.ok(lines.values.some((line) => String(line).includes("[INFO]")));
  assert.notEqual(lines.timestamps[1] - lines.timestamps[0], lines.timestamps[2] - lines.timestamps[1]);
});
