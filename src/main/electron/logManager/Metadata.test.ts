// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { WPILOGDecoder } from "../../../hub/dataSources/wpilog/WPILOGDecoder";
import { extractMetadata } from "./Metadata";

test("sample MCAP metadata reads robot, wall clock and summary duration", async () => {
  const metadata = await extractMetadata(path.resolve("sampleLogs/terrascope-sample.mcap"));
  assert.equal(metadata.robot, "TerraScope sample robot");
  assert.equal(metadata.date, Date.parse("2026-01-01T12:00:00.000Z"));
  assert.equal(metadata.duration, 40);
});

test("existing WPILOG fixture gets its duration without decoding sample fields", async () => {
  const file = path.resolve("docs/evidence/chunk-16/two-sources.wpilog");
  const timestamps: number[] = [];
  new WPILOGDecoder(fs.readFileSync(file)).forEach((record) => {
    if (!record.isControl()) timestamps.push(record.getTimestamp());
  });
  assert(timestamps.length > 0);
  const metadata = await extractMetadata(file);
  assert.equal(metadata.duration, (Math.max(...timestamps) - Math.min(...timestamps)) / 1e6);
  assert.equal(metadata.error, undefined);
});

test("other supported formats can leave duration blank", async () => {
  assert.deepEqual(await extractMetadata(path.resolve("recording.jsonl")), {});
});
