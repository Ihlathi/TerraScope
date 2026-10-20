// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { McapStreamReader } from "@mcap/core";
import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import ROS2Decoder from "../../../shared/log/ROS2Decoder";

type McapSchemaRecord = {
  id: number;
  name: string;
  encoding: string;
  data: Uint8Array;
};

type McapChannelRecord = {
  id: number;
  schemaId: number;
  topic: string;
  messageEncoding: string;
  metadata: Map<string, string>;
};

/** Reads an MCAP file into a log. Every declared channel and schema is kept. */
export default class MCAPDecoder {
  decode(log: Log, data: Uint8Array, progress: (value: number) => void) {
    const reader = new McapStreamReader();
    reader.append(data);

    const schemas = new Map<number, McapSchemaRecord>();
    const channels = new Map<number, McapChannelRecord>();
    const fieldKeys = new Map<number, string>();
    const topicOwners = new Map<string, number>();
    const touched = new Set<number>();
    const totalBytes = data.byteLength || 1;
    const rosDecoders = new Map<number, ROS2Decoder>();

    for (let record = reader.nextRecord(); record !== undefined; record = reader.nextRecord()) {
      if (record.type === "Schema") {
        schemas.set(record.id, {
          id: record.id,
          name: record.name,
          encoding: record.encoding,
          data: record.data
        });
      } else if (record.type === "Channel") {
        if (!channels.has(record.id)) {
          channels.set(record.id, {
            id: record.id,
            schemaId: record.schemaId,
            topic: record.topic,
            messageEncoding: record.messageEncoding,
            metadata: record.metadata
          });
        }
      } else if (record.type === "Message") {
        const channel = channels.get(record.channelId);
        if (channel !== undefined) {
          const key = fieldKeyFor(channel, fieldKeys, topicOwners);
          const schema = schemas.get(channel.schemaId);
          if (channel.messageEncoding === "cdr" && schema?.encoding === "ros2msg") {
            let decoder = rosDecoders.get(schema.id);
            if (decoder === undefined) {
              decoder = new ROS2Decoder(schema.name, new TextDecoder().decode(schema.data));
              rosDecoders.set(schema.id, decoder);
            }
            decoder.write(log, key, nanosToSeconds(record.logTime), record.data);
          } else {
            writeMessage(log, key, nanosToSeconds(record.logTime), channel.messageEncoding, schema, record.data);
          }
          touched.add(channel.id);
        }
      }
      progress(Math.min(1, 1 - reader.bytesRemaining() / totalBytes));
    }

    if (!reader.done()) {
      throw new Error("Incomplete MCAP file");
    }

    for (const channel of channels.values()) {
      const key = fieldKeyFor(channel, fieldKeys, topicOwners);
      const schema = channel.schemaId === 0 ? undefined : schemas.get(channel.schemaId);
      if (!touched.has(channel.id)) {
        log.createBlankField(key, LoggableType.Empty);
      }
      annotate(log, key, channel, schema);
    }

    const usedSchemaKeys = new Set<string>();
    for (const schema of schemas.values()) {
      writeSchema(log, schema, usedSchemaKeys);
    }
    progress(1);
  }
}

function fieldKeyFor(channel: McapChannelRecord, cache: Map<number, string>, owners: Map<string, number>): string {
  const existing = cache.get(channel.id);
  if (existing !== undefined) return existing;

  let base = channel.topic;
  if (base.length === 0) base = "MCAP/channels/" + channel.id.toString();
  let key = base;
  const owner = owners.get(base);
  if (owner !== undefined && owner !== channel.id) {
    key = base + "#" + channel.id.toString();
  } else {
    owners.set(base, channel.id);
  }
  cache.set(channel.id, key);
  return key;
}

function writeMessage(
  log: Log,
  key: string,
  timestamp: number,
  messageEncoding: string,
  schema: McapSchemaRecord | undefined,
  data: Uint8Array
) {
  if (messageEncoding.toLowerCase() === "json") {
    const text = decodeText(data);
    if (text === null) {
      log.putRaw(key, timestamp, data);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      log.putString(key, timestamp, text);
      return;
    }
    if (isValueWrapper(parsed)) {
      if (writeScalar(log, key, timestamp, parsed.value, schema?.name)) return;
      log.putJSON(key, timestamp, JSON.stringify(parsed.value));
      return;
    }
    if (writeScalar(log, key, timestamp, parsed, schema?.name)) return;
    log.putJSON(key, timestamp, text);
    return;
  }

  log.putRaw(key, timestamp, data);
}

function writeScalar(
  log: Log,
  key: string,
  timestamp: number,
  value: unknown,
  schemaName: string | undefined
): boolean {
  switch (typeof value) {
    case "boolean":
      log.putBoolean(key, timestamp, value);
      return true;
    case "number":
      if (!Number.isFinite(value)) return false;
      log.putNumber(key, timestamp, value);
      return true;
    case "string":
      log.putString(key, timestamp, value);
      return true;
  }

  if (!Array.isArray(value)) return false;
  if (value.length === 0) {
    if (schemaName === "boolean[]") {
      log.putBooleanArray(key, timestamp, []);
      return true;
    }
    if (schemaName === "number[]") {
      log.putNumberArray(key, timestamp, []);
      return true;
    }
    if (schemaName === "string[]") {
      log.putStringArray(key, timestamp, []);
      return true;
    }
    return false;
  }
  if (value.every((item) => typeof item === "boolean")) {
    log.putBooleanArray(key, timestamp, value);
    return true;
  }
  if (value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    log.putNumberArray(key, timestamp, value);
    return true;
  }
  if (value.every((item) => typeof item === "string")) {
    log.putStringArray(key, timestamp, value);
    return true;
  }
  return false;
}

function annotate(log: Log, key: string, channel: McapChannelRecord, schema: McapSchemaRecord | undefined) {
  if (log.getField(key) === null) return;
  if (schema !== undefined && schema.name.length > 0) {
    log.setStructuredType(key, schema.name);
  }
  const metadata: { [key: string]: unknown } = {
    messageEncoding: channel.messageEncoding
  };
  if (schema !== undefined) {
    metadata.schema = schema.name;
    metadata.schemaEncoding = schema.encoding;
  }
  if (channel.metadata.size > 0) {
    const channelMetadata: { [key: string]: string } = {};
    channel.metadata.forEach((value, name) => {
      channelMetadata[name] = value;
    });
    metadata.channelMetadata = channelMetadata;
  }
  log.setMetadataString(key, JSON.stringify(metadata));
}

function writeSchema(log: Log, schema: McapSchemaRecord, used: Set<string>) {
  const key = schemaCatalogKey(schema, used);
  const text = decodeText(schema.data);
  if (text === null) {
    log.putRaw(key, 0, schema.data);
  } else {
    log.putString(key, 0, text);
  }
  if (schema.name.length > 0) {
    log.setStructuredType(key, schema.name);
  }
  log.setMetadataString(
    key,
    JSON.stringify({
      schema: schema.name,
      schemaEncoding: schema.encoding
    })
  );
}

function schemaCatalogKey(schema: McapSchemaRecord, used: Set<string>): string {
  const baseName = (schema.name.length > 0 ? schema.name : "id-" + schema.id.toString()).replaceAll("/", ".");
  let key = "MCAP/schemas/" + baseName;
  if (used.has(key)) key = "MCAP/schemas/" + baseName + "#" + schema.id.toString();
  used.add(key);
  return key;
}

function isValueWrapper(value: unknown): value is { value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, "value")
  );
}

function decodeText(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function nanosToSeconds(nanos: bigint): number {
  return Number(nanos) / 1e9;
}
