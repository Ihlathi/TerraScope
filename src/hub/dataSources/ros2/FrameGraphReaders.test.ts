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
import { frameGraphForSource, readSourceFrame } from "../../../shared/log/FrameGraph";
import Log from "../../../shared/log/Log";
import { readSensorPoints } from "../../../shared/log/SpatialSensor";
import MCAPDecoder from "../mcap/MCAPDecoder";
import ROS2BagDecoder from "./ROS2BagDecoder";

function fixture(): Uint8Array {
  return new Uint8Array(readFileSync(path.join(process.cwd(), "src/hub/dataSources/ros2/fixtures/transform-tree.db3")));
}

function assertTransforms(log: Log) {
  assert.equal(log.getStructuredType("/tf"), "tf2_msgs/msg/TFMessage");
  assert.equal(readSourceFrame(log, "/scan", 1.5), "laser");
  assert.equal(readSensorPoints(log, "/scan", 1.5).length, 91 * 3);
  assert.deepEqual(readSensorPoints(log, "/scan", 1.5), readSensorPoints(log, "/scan", 2.5));
  assert.equal(readSensorPoints(log, "/cloud", 2.5).length, 9);
  const graph = frameGraphForSource(log, "/scan");
  const first = graph.resolve("laser", "map", 1.5);
  const second = graph.resolve("laser", "map", 2.5);
  assert.equal(first.status, "resolved");
  assert.equal(second.status, "resolved");
  if (first.status !== "resolved" || second.status !== "resolved") throw new Error("Unresolved fixture frame");
  assert.deepEqual(first.pose.translation, [-1.5, -1, 0.25]);
  second.pose.translation.forEach((v, i) => assert.ok(Math.abs(v - [2, 1.5, 0.25][i]) < 1e-9));
  assert.deepEqual(graph.resolve("orphan_sensor", "map", 1.5), { status: "missing-parent", frame: "missing_mount" });
}

test("ROS 2 bag resolves static and dynamic transforms around a constant child-frame scan", async () => {
  const log = new Log(false);
  await new ROS2BagDecoder().decode(log, fixture(), () => {});
  assertTransforms(log);
  assertTransforms(Log.fromSerialized(log.toSerialized()));
});

test("MCAP resolves the same transform-tree CDR through the shared decoder", async () => {
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
  assertTransforms(log);
});
