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
import { test } from "node:test";
import { HostKeys, hostFingerprint } from "./HostKeys";

test("host keys require first trust, match without prompting, and refuse mismatches with both fingerprints", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-hosts-"));
  try {
    const filename = path.join(directory, "known_hosts");
    const hosts = new HostKeys(filename);
    const key = Buffer.from("local fixture host key");
    const changed = Buffer.from("different host key");
    let prompts = 0;
    assert.equal(
      await hosts.verify("127.0.0.1", 2222, key, async (prompt) => {
        prompts++;
        assert.equal(prompt.fingerprint, hostFingerprint(key));
        return false;
      }),
      false
    );
    assert.equal(fs.existsSync(filename), false);
    assert.equal(
      await hosts.verify("127.0.0.1", 2222, key, async () => {
        prompts++;
        return true;
      }),
      true
    );
    assert.equal(
      await new HostKeys(filename).verify("127.0.0.1", 2222, key, async () => {
        throw new Error("Must not prompt on match.");
      }),
      true
    );
    assert.equal(prompts, 2);
    await assert.rejects(
      hosts.verify("127.0.0.1", 2222, changed, async () => {
        throw new Error("Must not prompt on mismatch.");
      }),
      (error: Error) => {
        assert(error.message.includes(hostFingerprint(key)));
        assert(error.message.includes(hostFingerprint(changed)));
        return true;
      }
    );
    assert.equal(await hosts.verify("127.0.0.1", 2223, changed, async () => false), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("closing a session during trust does not persist or accept its key", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-hosts-cancel-"));
  try {
    const filename = path.join(directory, "known_hosts");
    let active = true;
    assert.equal(
      await new HostKeys(filename).verify(
        "robot.local",
        22,
        Buffer.from("key"),
        async () => {
          active = false;
          return true;
        },
        () => active
      ),
      false
    );
    assert.equal(fs.existsSync(filename), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
