// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, TestContext } from "node:test";
import { LogMetadata } from "../../../shared/LogManager";
import { LogLibrary } from "./Library";

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "terrascope-library-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sample = path.join(directory, "sample.mcap");
  fs.writeFileSync(sample, "sample");
  const folder = path.join(directory, "logs");
  const index = path.join(directory, "index.json");
  return { directory, sample, folder, index };
}

test("library discovers logs, records opens anywhere and retains robot names and tags across rename and reload", async (t) => {
  const { directory, sample, folder, index } = setup(t);
  const library = new LogLibrary(
    index,
    folder,
    sample,
    async () => {},
    async () => ({})
  );
  const log = path.join(folder, "robot.csv");
  const outside = path.join(directory, "outside.jsonl");
  fs.writeFileSync(log, "time,current\n0,3");
  fs.writeFileSync(outside, '{"time":1}');
  fs.writeFileSync(path.join(folder, "ignored.txt"), "ignored");
  library.addOpened(outside);
  library.addDownloaded(log, "Orange Pi");
  library.setTags(log, [" ramp ", "ramp", "test"]);
  const before = await library.list();
  assert.equal(before[0].name, "TerraScope sample robot");
  assert.equal(before[0].readOnly, true);
  assert.deepEqual(before.map((entry) => entry.path).sort(), [sample, log, outside].sort());
  await library.rename(log, "renamed.csv");
  const renamed = path.join(folder, "renamed.csv");
  assert.equal(fs.existsSync(log), false);
  assert.equal(fs.readFileSync(renamed, "utf8"), "time,current\n0,3");
  const restored = new LogLibrary(index, folder, sample, async () => {});
  const entry = (await restored.list()).find((entry) => entry.path === renamed)!;
  assert.equal(entry.robot, "Orange Pi");
  assert.deepEqual(entry.tags, ["ramp", "test"]);
  assert.equal(entry.format, "CSV");
});

test("rename refuses collisions and paths and leaves both files intact", async (t) => {
  const { sample, folder, index } = setup(t);
  const library = new LogLibrary(index, folder, sample, async () => {});
  const original = path.join(folder, "original.csv");
  const existing = path.join(folder, "existing.csv");
  fs.writeFileSync(original, "original");
  fs.writeFileSync(existing, "existing");
  await library.list();
  await assert.rejects(library.rename(original, "existing.csv"));
  for (const invalid of ["../escaped.csv", "C:\\escaped.csv", "bad\0.csv", "CON.csv", "other.txt"]) {
    await assert.rejects(library.rename(original, invalid));
  }
  assert.equal(fs.readFileSync(original, "utf8"), "original");
  assert.equal(fs.readFileSync(existing, "utf8"), "existing");
});

test("trash is injected, preserves entries on failure and removes them after success", async (t) => {
  const { sample, folder, index } = setup(t);
  const calls: string[] = [];
  let fail = true;
  const library = new LogLibrary(index, folder, sample, async (file) => {
    calls.push(file);
    if (fail) throw new Error("Trash unavailable");
    await fs.promises.unlink(file);
  });
  const log = path.join(folder, "robot.csv");
  fs.writeFileSync(log, "log");
  library.addOpened(log);
  library.setTags(log, ["keep on failure"]);
  await assert.rejects(library.trash(log), /Trash unavailable/);
  assert.equal(fs.existsSync(log), true);
  assert.deepEqual((await library.list()).find((entry) => entry.path === log)!.tags, ["keep on failure"]);
  fail = false;
  await library.trash(log);
  assert.deepEqual(calls, [log, log]);
  assert.equal(
    (await library.list()).some((entry) => entry.path === log),
    false
  );
});

test("sample refuses rename, trash and tags including filesystem aliases", async (t) => {
  const { directory, sample, folder, index } = setup(t);
  let trashCalls = 0;
  const library = new LogLibrary(index, folder, sample, async () => {
    trashCalls++;
  });
  const symlink = path.join(directory, "alias.mcap");
  const hardlink = path.join(directory, "hardlink.mcap");
  fs.symlinkSync(sample, symlink);
  fs.linkSync(sample, hardlink);
  for (const file of [sample, symlink, hardlink]) {
    library.addOpened(file);
    await assert.rejects(library.rename(file, "changed.mcap"), /read-only/);
    await assert.rejects(library.trash(file), /read-only/);
    assert.throws(() => library.setTags(file, ["changed"]), /read-only/);
  }
  assert.equal(trashCalls, 0);
  assert.equal(fs.readFileSync(sample, "utf8"), "sample");
});

test("missing logs retain tags until explicitly removed", async (t) => {
  const { sample, folder, index } = setup(t);
  const library = new LogLibrary(index, folder, sample, async () => {});
  const log = path.join(folder, "gone.csv");
  fs.writeFileSync(log, "log");
  library.addOpened(log);
  library.setTags(log, ["remember"]);
  assert.throws(() => library.removeMissing(log), /still exists/);
  fs.unlinkSync(log);
  const restored = new LogLibrary(index, folder, sample, async () => {});
  const missing = (await restored.list()).find((entry) => entry.path === log)!;
  assert.equal(missing.missing, true);
  assert.deepEqual(missing.tags, ["remember"]);
  restored.removeMissing(log);
  assert.equal(
    (await restored.list()).some((entry) => entry.path === log),
    false
  );
});

test("remove missing accepts a folder path that became a file", async (t) => {
  const { sample, folder, index } = setup(t);
  const library = new LogLibrary(index, folder, sample, async () => {});
  const log = path.join(folder, "gone.csv");
  fs.writeFileSync(log, "log");
  library.addOpened(log);
  fs.unlinkSync(log);
  fs.rmdirSync(folder);
  fs.writeFileSync(folder, "folder replaced");
  assert.equal((await library.list()).find((entry) => entry.path === log)!.missing, true);
  library.removeMissing(log);
  assert.equal(
    (await library.list()).some((entry) => entry.path === log),
    false
  );
});

test("metadata cache uses path, size and mtime and follows rename", async (t) => {
  const { sample, folder, index } = setup(t);
  const calls: string[] = [];
  const extract = async (file: string) => {
    calls.push(file);
    return { robot: "Metadata robot", duration: 40 };
  };
  const library = new LogLibrary(index, folder, sample, async () => {}, extract);
  const log = path.join(folder, "robot.csv");
  fs.writeFileSync(log, "log");
  library.addDownloaded(log, "Profile robot");
  await library.list();
  await new Promise(setImmediate);
  assert.equal((await library.list()).find((entry) => entry.path === log)!.robot, "Metadata robot");
  await library.list();
  assert.deepEqual(calls, [sample, log]);
  await library.rename(log, "renamed.csv");
  const renamed = path.join(folder, "renamed.csv");
  await library.list();
  assert.deepEqual(calls, [sample, log]);
  fs.appendFileSync(renamed, "changed");
  await library.list();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [sample, log, renamed]);
  const changedStat = fs.statSync(renamed);
  fs.utimesSync(renamed, changedStat.atime, new Date(changedStat.mtimeMs + 1000));
  await library.list();
  await new Promise(setImmediate);
  assert.deepEqual(calls, [sample, log, renamed, renamed]);
  const restored = new LogLibrary(index, folder, sample, async () => {}, extract);
  await restored.list();
  assert.deepEqual(calls, [sample, log, renamed, renamed]);
});

test("uncached metadata never delays the library list and refreshes after extraction", async (t) => {
  const { sample, folder, index } = setup(t);
  let release!: (metadata: LogMetadata) => void;
  const pending = new Promise<LogMetadata>((resolve) => {
    release = resolve;
  });
  const library = new LogLibrary(
    index,
    folder,
    sample,
    async () => {},
    async () => pending
  );
  let changes = 0;
  library.onMetadataChanged = () => {
    changes++;
  };
  const log = path.join(folder, "robot.csv");
  fs.writeFileSync(log, "log");
  library.addDownloaded(log, "Profile name");
  const initial = (await library.list()).find((entry) => entry.path === log)!;
  assert.equal(initial.robot, "Profile name");
  assert.equal(initial.duration, undefined);
  assert.equal(changes, 0);
  release({ robot: "Recorded name", duration: 40 });
  await new Promise(setImmediate);
  const updated = (await library.list()).find((entry) => entry.path === log)!;
  assert.equal(updated.robot, "Recorded name");
  assert.equal(updated.duration, 40);
  assert(changes > 0);
});

test("additional library folders and download selection persist", async (t) => {
  const { directory, sample, folder, index } = setup(t);
  const library = new LogLibrary(index, folder, sample, async () => {});
  const additional = path.join(directory, "second");
  library.setDownloadFolder(additional);
  fs.writeFileSync(path.join(additional, "second.wpilog"), "log");
  library.addFolder(folder);
  const restored = new LogLibrary(index, folder, sample, async () => {});
  assert.equal(restored.downloadFolder, additional);
  assert.deepEqual(restored.folders, [folder, additional]);
  assert.equal(
    (await restored.list()).some((entry) => entry.name === "second.wpilog"),
    true
  );
});

test("malformed index is reported without replacing the user's data", (t) => {
  const { sample, folder, index } = setup(t);
  fs.writeFileSync(index, "{broken json");
  assert.throws(() => new LogLibrary(index, folder, sample, async () => {}), /Cannot read the log library index/);
  assert.equal(fs.readFileSync(index, "utf8"), "{broken json");
});

test("removing a library folder preserves indexed files and refuses to remove the download folder", async (t) => {
  const { directory, sample, folder, index } = setup(t);
  const library = new LogLibrary(index, folder, sample, async () => {});
  const extra = path.join(directory, "extra");
  library.addFolder(extra);
  const log = path.join(extra, "test.csv");
  fs.writeFileSync(log, "time,current\n0,1");
  await library.list();
  library.removeFolder(extra);
  assert.deepEqual(library.folders, [folder]);
  assert((await library.list()).some((entry) => entry.path === log));
  assert(fs.existsSync(log));
  assert.throws(() => library.removeFolder(folder), /different download folder/);
  const restored = new LogLibrary(index, folder, sample, async () => {});
  assert.deepEqual(restored.folders, [folder]);
});
