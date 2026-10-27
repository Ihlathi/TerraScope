// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { loadURDFSource, URDFSourceKind } from "./URDFSources";

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "urdf-sources-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = path.join(directory, "urdf-sources.json");
  const robot = path.join(directory, "robot.urdf");
  fs.writeFileSync(robot, '<robot name="test"><link name="base"/></robot>');
  return { directory, registry, robot };
}

test("layout-supplied URLs cannot read a file or persist a source", async (t) => {
  const { directory, registry } = fixture(t);
  const secret = path.join(directory, "id_rsa");
  fs.writeFileSync(secret, "PRIVATE KEY");
  const opened: unknown[] = [];
  const original = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, "open", (...args: Parameters<typeof fs.promises.open>) => {
    opened.push(args[0]);
    return original(...args);
  });
  let picks = 0;
  for (const kind of ["robot", "packages", "resources"] as const) {
    const request = {
      action: "restore" as const,
      kind,
      reference: undefined,
      url: pathToFileURL(secret).href
    };
    await assert.rejects(
      loadURDFSource(registry, request, async () => {
        picks++;
        return secret;
      }),
      /Select the local source again/
    );
  }
  assert.deepEqual(opened, []);
  assert.equal(picks, 0);
  assert.equal(fs.existsSync(registry), false);
});

test("corrupt and wrong-shaped registries do not prevent picking and saving a robot", async (t) => {
  const { registry, robot } = fixture(t);
  const invalid = [
    "{bad json",
    "null",
    "[]",
    "42",
    JSON.stringify({ broken: null }),
    JSON.stringify({ broken: { kind: "robot", path: 42 } }),
    JSON.stringify({ broken: { kind: 42, path: robot } }),
    JSON.stringify({ broken: { kind: "other", path: robot } }),
    JSON.stringify({ broken: { kind: "robot", path: "relative.urdf" } })
  ];
  for (const contents of invalid) {
    fs.writeFileSync(registry, contents);
    let picks = 0;
    const picked = await loadURDFSource(registry, { action: "pick", kind: "robot" }, async () => {
      picks++;
      return robot;
    });
    assert.equal(picks, 1);
    assert.equal(picked?.xml, fs.readFileSync(robot, "utf8"));
    assert(picked?.reference);
    const saved = JSON.parse(fs.readFileSync(registry, "utf8"));
    assert.deepEqual(Object.keys(saved), [picked.reference]);
    const restored = await loadURDFSource(
      registry,
      { action: "restore", kind: "robot", reference: picked.reference },
      async () => assert.fail("Restoring a selected source does not open the picker")
    );
    assert.equal(restored?.xml, picked.xml);
  }
});

test("restore requires an own registry ID and matching kind", async (t) => {
  const { registry, robot } = fixture(t);
  fs.writeFileSync(registry, JSON.stringify({ known: { kind: "robot", path: robot } }));
  const contents = fs.readFileSync(registry, "utf8");
  for (const reference of ["toString", "constructor", "__proto__", "missing"]) {
    await assert.rejects(
      loadURDFSource(registry, { action: "restore", kind: "robot", reference }, async () => null),
      /Select the local source again/
    );
  }
  await assert.rejects(
    loadURDFSource(registry, { action: "restore", kind: "packages", reference: "known" }, async () => null),
    /Select the local source again/
  );
  assert.equal(fs.readFileSync(registry, "utf8"), contents);
});

test("picked robot sources require a regular URDF file no larger than 10 MiB", async (t) => {
  const { directory, registry, robot } = fixture(t);
  const unsupported = path.join(directory, "private.txt");
  fs.writeFileSync(unsupported, "PRIVATE");
  await assert.rejects(
    loadURDFSource(registry, { action: "pick", kind: "robot" }, async () => unsupported),
    /\.urdf/
  );
  const folder = path.join(directory, "folder.urdf");
  fs.mkdirSync(folder);
  await assert.rejects(
    loadURDFSource(registry, { action: "pick", kind: "robot" }, async () => folder),
    /regular file/
  );
  fs.truncateSync(robot, 10 * 1024 * 1024 + 1);
  await assert.rejects(
    loadURDFSource(registry, { action: "pick", kind: "robot" }, async () => robot),
    /size limit/
  );
  assert.equal(fs.existsSync(registry), false);
});

test("package and mesh directories restore only after user selection", async (t) => {
  const { directory, registry, robot } = fixture(t);
  for (const kind of ["packages", "resources"] as URDFSourceKind[]) {
    const source = await loadURDFSource(registry, { action: "pick", kind }, async () => directory);
    assert(source);
    assert.equal(source.url, pathToFileURL(directory + path.sep).href);
    const restored = await loadURDFSource(
      registry,
      { action: "restore", kind, reference: source.reference },
      async () => assert.fail("Restore uses the user-selected registry entry")
    );
    assert.deepEqual(restored, { ...source, restoring: true });
    await assert.rejects(
      loadURDFSource(registry, { action: "pick", kind }, async () => robot),
      /directory/
    );
  }
});

test("corrupt registries do not prevent picking package or mesh directories", async (t) => {
  const { directory, registry } = fixture(t);
  for (const kind of ["packages", "resources"] as const) {
    for (const contents of ["{bad json", "null", "[]", '{"broken":{"kind":42,"path":false}}']) {
      fs.writeFileSync(registry, contents);
      let picks = 0;
      const source = await loadURDFSource(registry, { action: "pick", kind }, async () => {
        picks++;
        return directory;
      });
      assert.equal(picks, 1);
      assert.equal(source?.kind, kind);
      assert(source?.reference);
      assert.deepEqual(JSON.parse(fs.readFileSync(registry, "utf8"))[source.reference], { kind, path: directory });
    }
  }
});

test(
  "a picked FIFO with a URDF extension is rejected without blocking",
  { skip: process.platform === "win32" },
  async (t) => {
    const { directory, registry } = fixture(t);
    const fifo = path.join(directory, "pipe.urdf");
    execFileSync("mkfifo", [fifo]);
    await assert.rejects(
      loadURDFSource(registry, { action: "pick", kind: "robot" }, async () => fifo),
      /regular file/
    );
    assert.equal(fs.existsSync(registry), false);
  }
);
