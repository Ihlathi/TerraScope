// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";

/** Turns one JSON object frame into log fields. The transport does not call this. */
export class JsonFrameDecoder {
  latestTime = 0;

  decode(log: Log, frame: Uint8Array): boolean {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(frame));
    } catch {
      return false;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as { [key: string]: unknown };
    if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) return false;
    const timestamp = record.timestamp;
    this.latestTime = timestamp;
    let wrote = false;
    for (const key of Object.keys(record)) {
      if (key === "timestamp") continue;
      const field = record[key];
      if (typeof field === "number" && Number.isFinite(field)) {
        log.putNumber(key, timestamp, field);
        wrote = true;
      } else if (typeof field === "boolean") {
        log.putBoolean(key, timestamp, field);
        wrote = true;
      } else if (typeof field === "string") {
        log.putString(key, timestamp, field);
        wrote = true;
      } else if (field !== null && typeof field === "object") {
        log.putJSON(key, timestamp, JSON.stringify(field));
        wrote = true;
      }
    }
    return wrote;
  }
}
