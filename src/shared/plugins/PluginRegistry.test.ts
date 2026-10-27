// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import { registerTerraLogReader } from "../../examples/terraLogReader";
import { plugins } from "./builtins";
import { PluginRegistry } from "./PluginRegistry";

test("reader lookup uses registered extensions for paths and bare extensions", () => {
  assert.equal(plugins.getReader("/logs/run.WPILOG")?.id, plugins.getReader("wpilog")?.id);
  assert.equal(plugins.getReader(".mcap")?.worker, "mcapWorker.js");
  assert.equal(plugins.getReader("C:\\logs\\drive.db3")?.worker, "ros2BagWorker.js");
  assert.equal(plugins.getReader("unknown.no-reader"), undefined);
  for (const reader of plugins.getReaders()) {
    for (const extension of reader.extensions) assert.equal(plugins.getReader(`log.${extension}`), reader);
  }
});

test("two readers cannot claim the same extension and both ids appear in the error", () => {
  const registry = new PluginRegistry();
  registry.registerReader({
    id: "first-reader",
    displayName: "First reader",
    extensions: ["same"],
    worker: "first.js"
  });
  assert.throws(
    () =>
      registry.registerReader({
        id: "second-reader",
        displayName: "Second reader",
        extensions: ["same"],
        worker: "second.js"
      }),
    (error: unknown) =>
      error instanceof Error && error.message.includes("first-reader") && error.message.includes("second-reader")
  );
  assert.equal(registry.getReader("run.same")?.id, "first-reader");
});

test("open dialog filters contain every registered extension", () => {
  const filters = plugins.getFileFilters();
  const extensions = new Set(filters.flatMap((filter) => filter.extensions));
  for (const reader of plugins.getReaders()) {
    assert.ok(filters.some((filter) => filter.name === reader.displayName));
    for (const extension of reader.extensions) assert.ok(extensions.has(extension));
  }
});

test("production readers and open dialog filters exclude the TerraLog example", () => {
  assert.equal(plugins.getReader("terralog"), undefined);
  assert.equal(plugins.getReader("/logs/sample.TERRALOG"), undefined);
  assert.ok(plugins.getReaders().every((reader) => reader.id !== "example-terralog"));
  assert.ok(plugins.getReaders().every((reader) => reader.displayName !== "TerraLog example"));
  assert.ok(plugins.getReaders().every((reader) => !reader.extensions.includes("terralog")));
  assert.deepEqual(plugins.getFileFilters(), [
    {
      name: "Log files",
      extensions: [
        "wpilog",
        "wpilogxz",
        "hoot",
        "revlog",
        "rlog",
        "log",
        "csv",
        "tsv",
        "json",
        "jsonl",
        "mcap",
        "db3",
        "dslog",
        "dsevents"
      ]
    },
    { name: "WPILib robot log", extensions: ["wpilog"] },
    { name: "Compressed WPILib robot log", extensions: ["wpilogxz"] },
    { name: "Hoot robot log", extensions: ["hoot"] },
    { name: "REV Robotics CAN log", extensions: ["revlog"] },
    { name: "Robot log", extensions: ["rlog"] },
    { name: "Road Runner log", extensions: ["log"] },
    { name: "Comma-separated values", extensions: ["csv"] },
    { name: "Tab-separated values", extensions: ["tsv"] },
    { name: "JSON log", extensions: ["json"] },
    { name: "JSON Lines log", extensions: ["jsonl"] },
    { name: "MCAP log", extensions: ["mcap"] },
    { name: "ROS 2 sqlite3 bag", extensions: ["db3"] },
    { name: "NI Driver Station log", extensions: ["dslog", "dsevents"] }
  ]);
});

test("the TerraLog example can be registered explicitly", () => {
  const registry = new PluginRegistry();
  registerTerraLogReader(registry);
  assert.deepEqual(registry.getReader("sample.terralog"), {
    id: "example-terralog",
    displayName: "TerraLog example",
    extensions: ["terralog"],
    worker: "terraLogWorker.js",
    preparation: "none"
  });
});

test("duplicate extension rejection does not register part of a reader", () => {
  const registry = new PluginRegistry();
  registry.registerReader({ id: "owner", displayName: "Owner", extensions: ["taken"], worker: "owner.js" });
  assert.throws(() =>
    registry.registerReader({
      id: "conflict",
      displayName: "Conflict",
      extensions: ["free", "TAKEN"],
      worker: "conflict.js"
    })
  );
  assert.equal(registry.getReader("free"), undefined);
  assert.deepEqual(
    registry.getReaders().map((reader) => reader.id),
    ["owner"]
  );
});

test("every existing custom schema exposes a decode entry point", () => {
  for (const id of ["URCL", "URCLr2_periodic", "URCLr3_periodic"]) {
    const schema = plugins.getSchema(id);
    assert.ok(schema, `Missing schema decoder ${id}`);
    assert.equal(schema.id, id);
    assert.ok(schema.displayName.length > 0);
    assert.equal(typeof schema.decode, "function");
  }
  assert.equal(plugins.getSchema("unknown-schema"), undefined);
});
