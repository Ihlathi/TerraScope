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
import LoggableType from "../../../shared/log/LoggableType";
import MCAPDecoder from "../mcap/MCAPDecoder";
import ROS2BagDecoder from "./ROS2BagDecoder";

function fixture() {
  return new Uint8Array(readFileSync(path.join(process.cwd(), "src/hub/dataSources/ros2/fixtures/sample.db3")));
}

async function decode(data = fixture()) {
  const log = new Log(false);
  const progress: number[] = [];
  await new ROS2BagDecoder().decode(log, data, (value) => progress.push(value));
  assert.equal(progress.at(-1), 1);
  return log;
}

test("reads sqlite3 ROS 2 topics, CDR fields, types, and recording timestamps", async () => {
  const log = await decode();
  assert.equal(log.getType("/battery"), LoggableType.Raw);
  assert.equal(log.getStructuredType("/battery"), "std_msgs/msg/Float64");
  assert.equal(log.getType("/battery/data"), LoggableType.Number);
  assert.deepEqual(log.getRange("/battery/data", -Infinity, Infinity), {
    timestamps: [1, 1.5, 2, 2.5, 3],
    values: [12.4, 12.1, 11.8, 12.2, 12.6]
  });
  assert.equal(log.getStructuredType("/robot/telemetry"), "example_msgs/msg/Telemetry");
  assert.deepEqual(log.getRange("/robot/telemetry/speed", -Infinity, Infinity)?.values, [0, 0.75, 1.5, 2.25, 3]);
  assert.deepEqual(log.getRange("/robot/telemetry/position/x", -Infinity, Infinity)?.values, [0, 1, 2, 3, 4]);
  assert.deepEqual(log.getRange("/robot/telemetry/position/y", -Infinity, Infinity)?.timestamps, [1, 1.5, 2, 2.5, 3]);
  assert.equal(log.getStructuredType("/empty"), "std_msgs/msg/Bool");
  assert.deepEqual(log.getRange("/empty", -Infinity, Infinity)?.timestamps, []);
  assert.equal(JSON.parse(log.getMetadataString("/battery")).messageEncoding, "cdr");
  assert.equal(JSON.parse(log.getMetadataString("/battery")).storage, "sqlite3");
  assert.deepEqual(log.getRange("/unknown", -Infinity, Infinity)?.values, [new Uint8Array([0, 1, 0, 0, 17])]);
  assert.deepEqual(log.getRange("/opaque", -Infinity, Infinity)?.values, [new TextEncoder().encode("opaque")]);
  assert.equal(log.getStructuredType("/unknown"), "example_msgs/msg/Unknown");
  assert.equal(log.getRange("/battery", -Infinity, Infinity)?.values[0] instanceof Uint8Array, true);
});

test("opens older sqlite3 bags without embedded definitions using common ROS 2 types", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fixture());
  db.run("DROP TABLE message_definitions");
  const data = db.export();
  db.close();
  const log = await decode(data);
  assert.deepEqual(log.getRange("/battery/data", -Infinity, Infinity)?.values, [12.4, 12.1, 11.8, 12.2, 12.6]);
  assert.equal(log.getType("/robot/telemetry"), LoggableType.Raw);
  assert.equal(log.getType("/robot/telemetry/speed"), null);
});

test("prefers embedded definitions to the common type catalog", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fixture());
  db.run("INSERT INTO message_definitions VALUES (2, 'std_msgs/msg/Float64', 'ros2msg', 'float64 voltage', '')");
  const data = db.export();
  db.close();
  const log = await decode(data);
  assert.equal(log.getType("/battery/data"), null);
  assert.deepEqual(log.getRange("/battery/voltage", -Infinity, Infinity)?.values, [12.4, 12.1, 11.8, 12.2, 12.6]);
});

test("converts sqlite integer nanoseconds without first rounding them to a number", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database(fixture());
  db.run("DELETE FROM messages WHERE topic_id != 1");
  db.run("UPDATE messages SET timestamp = 100000000000000008 WHERE id = (SELECT min(id) FROM messages)");
  const data = db.export();
  db.close();
  const log = await decode(data);
  assert.equal(log.getRange("/battery/data", -Infinity, Infinity)?.timestamps.at(-1), 100000000.00000001);
});

test("rejects invalid databases, missing topics, and truncated CDR", async () => {
  await assert.rejects(decode(new Uint8Array([1, 2, 3, 4])));
  const SQL = await initSqlJs();
  for (const sql of [
    "UPDATE messages SET topic_id = 999 WHERE id = 1",
    "UPDATE messages SET data = X'00010000' WHERE topic_id = 1",
    "UPDATE message_definitions SET encoded_message_definition = 'not a valid schema'"
  ]) {
    const db = new SQL.Database(fixture());
    db.run(sql);
    const data = db.export();
    db.close();
    await assert.rejects(decode(data));
  }
});

test("uses the same ROS 2 CDR path when a message comes from MCAP", async () => {
  const chunks: Uint8Array[] = [];
  let length = 0n;
  const writer = new McapWriter({
    writable: {
      position: () => length,
      write: async (data) => {
        chunks.push(data.slice());
        length += BigInt(data.length);
      }
    }
  });
  await writer.start({ library: "TerraScope test", profile: "ros2" });
  const schemaId = await writer.registerSchema({
    name: "std_msgs/msg/Float64",
    encoding: "ros2msg",
    data: new TextEncoder().encode("float64 data\n")
  });
  const channelId = await writer.registerChannel({
    schemaId,
    topic: "/battery",
    messageEncoding: "cdr",
    metadata: new Map()
  });
  const payload = new Uint8Array(12);
  payload[1] = 1;
  new DataView(payload.buffer).setFloat64(4, 12.4, true);
  await writer.addMessage({ channelId, sequence: 0, logTime: 1500000000n, publishTime: 1000000000n, data: payload });
  await writer.end();
  const log = new Log(false);
  new MCAPDecoder().decode(log, Buffer.concat(chunks), () => {});
  assert.equal(log.getStructuredType("/battery"), "std_msgs/msg/Float64");
  assert.deepEqual(log.getRange("/battery/data", -Infinity, Infinity), { timestamps: [1.5], values: [12.4] });
  assert.deepEqual(log.getRange("/battery", -Infinity, Infinity)?.values, [payload]);
});
