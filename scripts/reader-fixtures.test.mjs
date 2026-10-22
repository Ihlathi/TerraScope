// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import builtins from "../build/unit-test/shared/plugins/builtins.js";
import { bundleReaders, decodeFixture, fixturePaths, openFixture } from "./reader-fixture-harness.mjs";

const { plugins } = builtins;
const root = process.cwd();
const output = path.join(root, "build", "reader-fixtures");
const baseline = JSON.parse(await readFile(new URL("./reader-fixture-fields.json", import.meta.url), "utf8"));
const readers = fixturePaths.map((fixture) => {
  const reader = plugins.getReader(fixture);
  assert.ok(reader, `No reader registered for ${fixture}`);
  return reader;
});
const exampleFixture = "src/examples/fixtures/sample.terralog";
const exampleReader = plugins.getReader(exampleFixture);
assert.ok(exampleReader);
await bundleReaders(root, [...readers.map((reader) => reader.worker), exampleReader.worker], output);

for (const [index, fixture] of fixturePaths.entries()) {
  test(`registered reader preserves fields in ${fixture}`, async () => {
    assert.deepEqual(await openFixture(root, fixture, readers[index].worker, output), baseline[fixture]);
  });
}

async function findFixtures(directory) {
  const fixtures = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) fixtures.push(...(await findFixtures(filename)));
    else if (filename.includes(`${path.sep}fixtures${path.sep}`) && plugins.getReader(filename)) {
      fixtures.push(path.relative(root, filename).split(path.sep).join("/"));
    }
  }
  return fixtures;
}

test("the regression baseline covers every existing reader fixture", async () => {
  const discovered = await findFixtures(path.join(root, "src", "hub", "dataSources"));
  assert.deepEqual(discovered.sort(), fixturePaths.filter((fixture) => fixture.startsWith("src/")).sort());
});

test("the public API example reader opens numeric samples", async () => {
  const log = await decodeFixture(root, exampleFixture, exampleReader.worker, output);
  assert.deepEqual(Object.keys(log.fields).sort(), ["BatteryVoltage", "Speed"]);
  assert.deepEqual(log.fields.BatteryVoltage.timestamps, [0, 1]);
  assert.deepEqual(log.fields.BatteryVoltage.values, [12.5, 12]);
  assert.deepEqual(log.fields.Speed.timestamps, [0, 1]);
  assert.deepEqual(log.fields.Speed.values, [0, 2.75]);
});
