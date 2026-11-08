// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  DISK_USAGE_COMMAND,
  listRemoteLogs,
  parseDiskUsage,
  ReadOnlySFTP,
  safeRemoteName,
  syncRemoteLogs
} from "./Remote";

function fixture(files: Record<string, Buffer>, sizes: Record<string, number> = {}) {
  const paths: string[] = [];
  const deletions: string[] = [];
  const sftp: ReadOnlySFTP & { unlink(): never; rmdir(): never; rename(): never } = {
    readdir(remotePath, callback) {
      paths.push(remotePath);
      callback(
        undefined,
        Object.keys(files).map((filename) => ({
          filename,
          attrs: {
            size: sizes[filename] ?? files[filename].length,
            mtime: 1700000000,
            mode: filename === "folder.mcap" ? 0o040755 : 0o100644
          }
        }))
      );
    },
    createReadStream(remotePath) {
      paths.push(remotePath);
      return Readable.from([files[path.posix.basename(remotePath)]]);
    },
    unlink() {
      deletions.push("unlink");
      throw new Error("Remote deletion forbidden");
    },
    rmdir() {
      deletions.push("rmdir");
      throw new Error("Remote deletion forbidden");
    },
    rename() {
      deletions.push("rename");
      throw new Error("Remote mutation forbidden");
    }
  };
  return { sftp, paths, deletions };
}

function temporary() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ts-sync-"));
}

test("listing uses reader extensions, filters non-files and unsafe names, and preserves names and dates", async () => {
  const { sftp, deletions } = fixture({
    "sample.mcap": Buffer.from("mcap"),
    "robot.WPILOG": Buffer.from("wpilog"),
    "values.tsv": Buffer.from("tsv"),
    "ignored.exe": Buffer.from("exe"),
    "folder.mcap": Buffer.alloc(0),
    "../escape.mcap": Buffer.alloc(0),
    "back\\slash.mcap": Buffer.alloc(0),
    "CON.mcap": Buffer.alloc(0)
  });
  const listed = await listRemoteLogs(sftp, "/home/robot/logs");
  assert.deepEqual(
    listed.map((file) => file.name),
    ["sample.mcap", "robot.WPILOG", "values.tsv"]
  );
  assert.equal(listed[0].size, 4);
  assert.equal(listed[0].modified, 1700000000000);
  assert.deepEqual(deletions, []);
});

test("sync skips same-size files and publishes complete files from local temporary names", async () => {
  const directory = temporary();
  try {
    const { sftp, paths, deletions } = fixture({
      "already.mcap": Buffer.from("same"),
      "new.mcap": Buffer.from("complete payload")
    });
    fs.writeFileSync(path.join(directory, "already.mcap"), "same");
    const events: string[] = [];
    const result = await syncRemoteLogs(
      sftp,
      "/home/robot/logs/",
      ["already.mcap", "new.mcap"],
      directory,
      new AbortController().signal,
      (event) => {
        events.push(event.state);
        if (event.state === "downloading") {
          assert(!fs.existsSync(path.join(directory, "new.mcap")), "Final name stays absent during transfer.");
        }
      }
    );
    assert.equal(fs.readFileSync(path.join(directory, "new.mcap"), "utf8"), "complete payload");
    assert.deepEqual(result.downloaded, [path.join(directory, "new.mcap")]);
    assert.deepEqual(result.skipped, [path.join(directory, "already.mcap")]);
    assert(events.includes("finished"));
    assert(paths.includes("/home/robot/logs/new.mcap"));
    assert(!paths.some((remotePath) => remotePath.includes("\\")));
    assert.deepEqual(fs.readdirSync(directory).sort(), ["already.mcap", "new.mcap"]);
    assert.deepEqual(deletions, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("size mismatch and interrupted streams leave no final or temporary file", async () => {
  const directory = temporary();
  try {
    const { sftp, deletions } = fixture({ "short.mcap": Buffer.from("short") }, { "short.mcap": 50 });
    await assert.rejects(
      syncRemoteLogs(sftp, "/logs", ["short.mcap"], directory, new AbortController().signal, () => {}),
      /size does not match/
    );
    assert.deepEqual(fs.readdirSync(directory), []);
    sftp.createReadStream = () =>
      Readable.from(
        (async function* () {
          yield Buffer.from("par");
          throw new Error("Interrupted fixture transfer");
        })()
      );
    await assert.rejects(
      syncRemoteLogs(sftp, "/logs", ["short.mcap"], directory, new AbortController().signal, () => {}),
      /Interrupted fixture/
    );
    assert.deepEqual(fs.readdirSync(directory), []);
    assert.deepEqual(deletions, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation during a transfer and on its final chunk leaves no corrupt final", async () => {
  const directory = temporary();
  try {
    const { sftp, deletions } = fixture({ "cancel.mcap": Buffer.from("payload") });
    for (const completeChunk of [false, true]) {
      const abort = new AbortController();
      sftp.createReadStream = () =>
        Readable.from(
          (async function* () {
            yield Buffer.from(completeChunk ? "payload" : "pay");
            abort.abort();
            if (!completeChunk) yield Buffer.from("load");
          })()
        );
      await assert.rejects(
        syncRemoteLogs(sftp, "/logs", ["cancel.mcap"], directory, abort.signal, () => {}),
        /abort/i
      );
      assert.deepEqual(fs.readdirSync(directory), []);
    }
    assert.deepEqual(deletions, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("path safety refuses traversal, local collisions, and symlink destinations", async () => {
  const directory = temporary();
  try {
    const { sftp, paths, deletions } = fixture({ "robot.mcap": Buffer.from("payload") });
    for (const name of [
      "../robot.mcap",
      "sub/robot.mcap",
      "sub\\robot.mcap",
      "/robot.mcap",
      "robot.mcap\0",
      "robot.mcap:stream",
      ".."
    ]) {
      assert.equal(safeRemoteName(name), false);
      await assert.rejects(
        syncRemoteLogs(sftp, "/logs", [name], directory, new AbortController().signal, () => {}),
        /Unsafe/
      );
    }
    assert.deepEqual(paths, [], "Unsafe selected names fail before any remote operation.");
    fs.writeFileSync(path.join(directory, "robot.mcap"), "existing");
    await assert.rejects(
      syncRemoteLogs(sftp, "/logs", ["robot.mcap"], directory, new AbortController().signal, () => {}),
      /already exists/
    );
    assert.equal(fs.readFileSync(path.join(directory, "robot.mcap"), "utf8"), "existing");
    fs.unlinkSync(path.join(directory, "robot.mcap"));
    fs.writeFileSync(path.join(directory, "target"), "payload");
    fs.symlinkSync(path.join(directory, "target"), path.join(directory, "robot.mcap"));
    await assert.rejects(
      syncRemoteLogs(sftp, "/logs", ["robot.mcap"], directory, new AbortController().signal, () => {}),
      /already exists/
    );
    assert.equal(fs.readFileSync(path.join(directory, "target"), "utf8"), "payload");
    assert.deepEqual(deletions, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Linux remote paths with shell punctuation never enter the fixed df command", async () => {
  const { sftp, paths } = fixture({ "robot.mcap": Buffer.from("payload") });
  const directory = "/logs with space/'$(touch PWNED);\nlogs";
  await listRemoteLogs(sftp, directory);
  assert.equal(paths[0], directory);
  assert.equal(DISK_USAGE_COMMAND, "LC_ALL=C xargs -0 df -Pk --");
  assert(!DISK_USAGE_COMMAND.includes(directory));
  assert.deepEqual(
    parseDiskUsage("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000 250 750 25% /\n"),
    { total: 1024000, used: 256000, available: 768000 }
  );
});

test("a concurrent destination cannot be overwritten when the verified temporary file is published", async (t) => {
  const directory = temporary();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { sftp, deletions } = fixture({ "robot.mcap": Buffer.from("payload") });
  const finalPath = path.join(directory, "robot.mcap");
  const link = fs.promises.link;
  t.mock.method(fs.promises, "link", async (source: fs.PathLike, destination: fs.PathLike) => {
    fs.writeFileSync(finalPath, "another writer", { flag: "wx" });
    return link(source, destination);
  });
  await assert.rejects(
    syncRemoteLogs(sftp, "/logs", ["robot.mcap"], directory, new AbortController().signal, () => {}),
    { code: "EEXIST" }
  );
  assert.equal(fs.readFileSync(finalPath, "utf8"), "another writer");
  assert.deepEqual(fs.readdirSync(directory), ["robot.mcap"]);
  assert.deepEqual(deletions, []);
});
