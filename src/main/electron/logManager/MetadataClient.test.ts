// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { MetadataClient } from "./MetadataClient";

test("metadata worker extracts sample and WPILOG while accepting queued requests", async (t) => {
  const client = new MetadataClient(path.join(__dirname, "metadataWorker.js"));
  t.after(() => client.close());
  const [sample, wpilog] = await Promise.all([
    client.extract(path.resolve("sampleLogs/terrascope-sample.mcap")),
    client.extract(path.resolve("docs/evidence/chunk-16/two-sources.wpilog"))
  ]);
  assert.equal(sample.robot, "TerraScope sample robot");
  assert.equal(sample.duration, 40);
  assert.equal(wpilog.error, undefined);
  assert.equal(typeof wpilog.duration, "number");
});

test("worker reports a failed file then continues with the next log", async (t) => {
  const client = new MetadataClient(path.join(__dirname, "metadataWorker.js"));
  t.after(() => client.close());
  const [missing, sample] = await Promise.all([
    client.extract(path.resolve("missing-log.mcap")),
    client.extract(path.resolve("sampleLogs/terrascope-sample.mcap"))
  ]);
  assert.match(missing.error ?? "", /ENOENT/);
  assert.equal(sample.duration, 40);
});

test("closing rejects active and queued metadata reads", async () => {
  const client = new MetadataClient(path.join(__dirname, "metadataWorker.js"));
  const active = assert.rejects(client.extract(path.resolve("sampleLogs/terrascope-sample.mcap")), /closed/);
  const queued = assert.rejects(client.extract(path.resolve("sampleLogs/terrascope-sample.mcap")), /closed/);
  client.close();
  await Promise.all([active, queued]);
  await assert.rejects(client.extract(path.resolve("sampleLogs/terrascope-sample.mcap")), /closed/);
});
