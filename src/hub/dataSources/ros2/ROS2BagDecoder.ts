// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import initSqlJs from "sql.js";
import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import ROS2Decoder from "../../../shared/log/ROS2Decoder";

type Topic = {
  name: string;
  decoder: ROS2Decoder | null;
};

export default class ROS2BagDecoder {
  async decode(log: Log, data: Uint8Array, progress: (value: number) => void) {
    const SQL = await initSqlJs();
    const db = new SQL.Database(data);
    try {
      const definitions = new Map<string, string>();
      if (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_definitions'").length > 0) {
        const statement = db.prepare(
          "SELECT topic_type, encoding, encoded_message_definition FROM message_definitions"
        );
        try {
          while (statement.step()) {
            const row = statement.get();
            if (row[1] === "ros2msg" && typeof row[0] === "string" && typeof row[2] === "string") {
              definitions.set(row[0], row[2]);
            }
          }
        } finally {
          statement.free();
        }
      }
      const topics = new Map<number, Topic>();
      const topicRows = db.prepare("SELECT id, name, type, serialization_format FROM topics");
      try {
        while (topicRows.step()) {
          const [id, name, type, encoding] = topicRows.get();
          if (
            typeof id !== "number" ||
            typeof name !== "string" ||
            typeof type !== "string" ||
            typeof encoding !== "string"
          ) {
            throw new Error("Invalid ROS 2 bag topic");
          }
          topics.set(id, {
            name,
            decoder: encoding === "cdr" ? new ROS2Decoder(type, definitions.get(type)) : null
          });
          log.createBlankField(name, LoggableType.Raw);
          log.setStructuredType(name, type);
          log.setMetadataString(name, JSON.stringify({ storage: "sqlite3", messageEncoding: encoding, schema: type }));
        }
      } finally {
        topicRows.free();
      }
      const total = Number(db.exec("SELECT count(*) FROM messages")[0].values[0][0]);
      const messages = db.prepare(
        "SELECT topic_id, CAST(timestamp AS TEXT), data FROM messages ORDER BY timestamp, id"
      );
      let count = 0;
      try {
        while (messages.step()) {
          const [topicId, nanos, payload] = messages.get();
          if (typeof topicId !== "number" || typeof nanos !== "string" || !(payload instanceof Uint8Array)) {
            throw new Error("Invalid ROS 2 bag message");
          }
          const topic = topics.get(topicId);
          if (topic === undefined) throw new Error("ROS 2 bag message references an unknown topic");
          const nanoseconds = BigInt(nanos);
          const timestamp = Number(nanoseconds / 1000000000n) + Number(nanoseconds % 1000000000n) / 1e9;
          if (topic.decoder === null) log.putRaw(topic.name, timestamp, payload);
          else topic.decoder.write(log, topic.name, timestamp, payload);
          count++;
          if (count % 1000 === 0) progress(count / total);
        }
      } finally {
        messages.free();
      }
      progress(1);
    } finally {
      db.close();
    }
  }
}
