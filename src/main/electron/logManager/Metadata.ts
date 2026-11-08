// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { McapIndexedReader } from "@mcap/core";
import fs from "node:fs/promises";
import path from "node:path";
import { LogMetadata } from "../../../shared/LogManager";

const SCAN_LIMIT = 16 * 1024 * 1024;

function applyMetadata(result: LogMetadata, fields: Iterable<[string, string]>): void {
  for (const [key, value] of fields) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (["robot", "robotname"].includes(normalized) && value.trim()) result.robot = value;
    if (["wallclockstart", "wallclockstarttime", "starttime", "recordingstart"].includes(normalized)) {
      const date = Date.parse(value);
      if (Number.isFinite(date)) result.date = date;
    }
  }
}

async function mcapMetadata(file: string): Promise<LogMetadata> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    let bytesRead = 0;
    const reader = await McapIndexedReader.Initialize({
      readable: {
        size: async () => BigInt(stat.size),
        read: async (offset, length) => {
          const start = Number(offset);
          const size = Number(length);
          bytesRead += size;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(size) ||
            start < 0 ||
            size < 0 ||
            start + size > stat.size ||
            bytesRead > SCAN_LIMIT
          ) {
            throw new Error("MCAP metadata exceeds the 16 MB scan limit.");
          }
          const buffer = Buffer.alloc(size);
          const read = await handle.read(buffer, 0, size, start);
          if (read.bytesRead !== size) throw new Error("MCAP changed while reading metadata.");
          return buffer;
        }
      }
    });
    const result: LogMetadata = {};
    const statistics = reader.statistics;
    if (statistics && statistics.messageCount > 0n) {
      result.duration = Number(statistics.messageEndTime - statistics.messageStartTime) / 1e9;
    }
    for await (const metadata of reader.readMetadata()) applyMetadata(result, metadata.metadata);
    return result;
  } finally {
    await handle.close();
  }
}

async function wpilogMetadata(file: string): Promise<LogMetadata> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const data = Buffer.alloc(Math.min(stat.size, SCAN_LIMIT));
    const read = await handle.read(data, 0, data.length, 0);
    if (read.bytesRead !== data.length || data.length < 12 || data.toString("ascii", 0, 6) !== "WPILOG") {
      throw new Error("Invalid WPILOG header.");
    }
    if (data.readUInt16LE(6) !== 0x100) throw new Error("Unsupported WPILOG version.");
    let position = 12 + data.readUInt32LE(8);
    let start = Infinity;
    let end = -Infinity;
    const fields = new Map<number, string>();
    const result: LogMetadata = {};
    const integer = (offset: number, length: number) => {
      let value = 0n;
      for (let byte = 0; byte < length; byte++) value |= BigInt(data[offset + byte]) << BigInt(byte * 8);
      return Number(value);
    };
    while (position < data.length) {
      const descriptor = data[position];
      const entryLength = (descriptor & 3) + 1;
      const sizeLength = ((descriptor >> 2) & 3) + 1;
      const timestampLength = ((descriptor >> 4) & 7) + 1;
      const headerLength = 1 + entryLength + sizeLength + timestampLength;
      if (position + headerLength > data.length) break;
      const entry = integer(position + 1, entryLength);
      const size = integer(position + 1 + entryLength, sizeLength);
      const timestamp = integer(position + 1 + entryLength + sizeLength, timestampLength);
      const payload = position + headerLength;
      if (payload + size > data.length) break;
      if (entry === 0 && size >= 9 && data[payload] === 0) {
        const id = data.readUInt32LE(payload + 1);
        const nameLength = data.readUInt32LE(payload + 5);
        if (nameLength <= size - 9) fields.set(id, data.toString("utf8", payload + 9, payload + 9 + nameLength));
      } else if (entry !== 0) {
        start = Math.min(start, timestamp);
        end = Math.max(end, timestamp);
        const name = fields.get(entry);
        if (name && size <= 4096 && /(?:^|\/)Metadata\/(?:Robot|RobotName|WallClockStart|StartTime)$/i.test(name)) {
          applyMetadata(result, [
            [name.slice(name.lastIndexOf("/") + 1), data.toString("utf8", payload, payload + size)]
          ]);
        }
      }
      position = payload + size;
    }
    if (data.length === stat.size && position === stat.size && Number.isFinite(start)) {
      result.duration = (end - start) / 1e6;
    }
    return result;
  } finally {
    await handle.close();
  }
}

export async function extractMetadata(file: string): Promise<LogMetadata> {
  switch (path.extname(file).toLowerCase()) {
    case ".mcap":
      return mcapMetadata(file);
    case ".wpilog":
      return wpilogMetadata(file);
    default:
      return {};
  }
}
