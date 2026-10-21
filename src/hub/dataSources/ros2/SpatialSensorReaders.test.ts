// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { McapWriter } from "@mcap/core";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import initSqlJs from "sql.js";
import Log from "../../../shared/log/Log";
import { SemanticType, classifyStructuredType } from "../../../shared/log/SemanticType";
import { readSensorPoints } from "../../../shared/log/SpatialSensor";
import MCAPDecoder from "../mcap/MCAPDecoder";
import ROS2BagDecoder from "./ROS2BagDecoder";

function fixture(): Uint8Array {
  return new Uint8Array(
    readFileSync(path.join(process.cwd(), "src/hub/dataSources/ros2/fixtures/spatial-sensors.db3"))
  );
}

function assertSensors(log: Log) {
  assert.equal(classifyStructuredType(log.getStructuredType("/scan")!), SemanticType.LaserScan);
  assert.equal(classifyStructuredType(log.getStructuredType("/cloud")!), SemanticType.PointCloud);
  const scan = readSensorPoints(log, "/scan", 1.5);
  const cloud = readSensorPoints(log, "/cloud", 1.5);
  assert.equal(scan.length, 181 * 3);
  assert.equal(cloud.length, 441 * 3);
  assert.deepEqual(scan.slice(0, 3), [3, 0, 0]);
  assert.ok(Math.abs(cloud[0] - 1.8) < 1e-6);
  assert.deepEqual(cloud.slice(1, 3), [-2, 0.25]);
  assert.ok(Math.abs(readSensorPoints(log, "/scan", 2)[0] - 3.3) < 1e-6);
  assert.ok(Math.abs(readSensorPoints(log, "/cloud", 2)[0] - 2.3) < 1e-6);
  for (const topic of ["/scan", "/cloud"]) {
    assert.deepEqual(readSensorPoints(log, topic, 0.5), []);
    assert.deepEqual(readSensorPoints(log, topic, 3), []);
    assert.ok(log.getRaw(topic, 1, 1)?.values[0] instanceof Uint8Array);
  }
}

test("ROS 2 sqlite3 fixture feeds laser scans and clouds through the shared decoder", async () => {
  const log = new Log(false);
  await new ROS2BagDecoder().decode(log, fixture(), () => {});
  assertSensors(log);
  assertSensors(Log.fromSerialized(log.toSerialized()));
});

test("MCAP feeds the same scan and cloud CDR through the shared decoder", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fixture());
  const chunks: Uint8Array[] = [];
  let length = 0n;
  const writer = new McapWriter({
    useChunks: false,
    writable: {
      position: () => length,
      write: async (data) => {
        chunks.push(data.slice());
        length += BigInt(data.length);
      }
    }
  });
  try {
    await writer.start({ library: "TerraScope test", profile: "ros2" });
    const channels = new Map<number, number>();
    const topics = db.exec(
      "SELECT topics.id, name, type, encoded_message_definition FROM topics JOIN message_definitions ON type = topic_type"
    )[0].values;
    for (const [id, topic, type, definition] of topics) {
      const schemaId = await writer.registerSchema({
        name: type as string,
        encoding: "ros2msg",
        data: new TextEncoder().encode(definition as string)
      });
      channels.set(
        id as number,
        await writer.registerChannel({ schemaId, topic: topic as string, messageEncoding: "cdr", metadata: new Map() })
      );
    }
    const messages = db.exec("SELECT topic_id, timestamp, data FROM messages ORDER BY timestamp, id")[0].values;
    for (const [id, time, data] of messages) {
      await writer.addMessage({
        channelId: channels.get(id as number)!,
        sequence: 0,
        logTime: BigInt(time as number),
        publishTime: BigInt(time as number),
        data: data as Uint8Array
      });
    }
    await writer.end();
  } finally {
    db.close();
  }
  const log = new Log(false);
  new MCAPDecoder().decode(log, Buffer.concat(chunks), () => {});
  assertSensors(log);
});
