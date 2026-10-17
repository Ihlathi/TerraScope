// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";

export type JSONLogFormat = "json" | "jsonl";

/** Reads an array of timestamped objects. JSONL is that array written one object per line. */
export default class JSONDecoder {
  decode(log: Log, data: string, progressCallback?: (progress: number) => void, format: JSONLogFormat = "json") {
    const text = data.charCodeAt(0) === 0xfeff ? data.slice(1) : data;
    const records = format === "json" ? parseJsonArray(text) : parseJsonLines(text);
    records.forEach((record, index) => {
      writeRecord(log, record);
      if (progressCallback !== undefined) {
        progressCallback((index + 1) / records.length);
      }
    });
  }
}

function parseJsonArray(data: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw `Could not parse JSON log: ${error}`;
  }
  if (!Array.isArray(parsed)) {
    throw "JSON log must be an array of objects";
  }
  return parsed;
}

function parseJsonLines(data: string): unknown[] {
  const records: unknown[] = [];
  data.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      records.push(JSON.parse(trimmed));
    } catch (error) {
      throw `Could not parse JSONL record: ${error}`;
    }
  });
  if (records.length === 0) {
    throw "JSONL log has no records";
  }
  return records;
}

function writeRecord(log: Log, record: unknown) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw "JSON log record must be an object";
  }
  const fields = record as { [key: string]: unknown };
  const timestamp = readTimestamp(fields);
  Object.keys(fields).forEach((key) => {
    if (key === "Timestamp" || key === "timestamp") return;
    writeField(log, key, timestamp, fields[key]);
  });
}

function readTimestamp(record: { [key: string]: unknown }): number {
  const raw = Object.prototype.hasOwnProperty.call(record, "Timestamp") ? record["Timestamp"] : record["timestamp"];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw "JSON log record is missing a numeric Timestamp";
  }
  return raw;
}

function writeField(log: Log, key: string, timestamp: number, value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    log.putNumber(key, timestamp, value);
    return;
  }
  if (typeof value === "boolean") {
    log.putBoolean(key, timestamp, value);
    return;
  }
  if (typeof value === "string") {
    log.putString(key, timestamp, value);
    return;
  }
  if (value === null) return;
  log.putJSON(key, timestamp, JSON.stringify(value));
}
