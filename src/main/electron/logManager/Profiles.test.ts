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
import { createPresets, parseProfile, ProfileStore } from "./Profiles";

const presets = createPresets({
  host: "robot.local",
  remotePath: "/U/logs",
  roborioUser: "lvuser",
  systemcoreUser: "systemcore"
});

test("profile serialization allowlists fields and never saves passwords or passphrases", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ts-profiles-"));
  try {
    const filename = path.join(directory, "profiles.json");
    const store = new ProfileStore(filename, presets);
    assert.deepEqual(store.load(), presets);
    const leaked = presets.map((profile) => ({
      ...profile,
      password: "session-password",
      passphrase: "session-passphrase",
      auth: { ...profile.auth, password: "auth-password", passphrase: "auth-passphrase" }
    }));
    assert.deepEqual(store.save(leaked), presets);
    assert.deepEqual(store.load(), presets);
    const serialized = fs.readFileSync(filename, "utf8");
    assert(!/password|passphrase/.test(serialized));
    const passwordProfile = { ...presets[0], auth: { kind: "password", password: "not-persisted" } };
    store.save([passwordProfile]);
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.deepEqual(saved[0].auth, { kind: "password" });
    assert(!fs.readFileSync(filename, "utf8").includes("not-persisted"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("profile validation keeps Linux paths absolute and rejects invalid ports and hosts", () => {
  const profile = presets[0];
  assert.equal(parseProfile({ ...profile, remotePath: "/home/robot/logs/../logs" }).remotePath, "/home/robot/logs");
  for (const remotePath of ["relative/logs", "C:\\logs", "/logs\0bad"])
    assert.throws(() => parseProfile({ ...profile, remotePath }));
  for (const port of [0, 65536, 22.5, "22"]) assert.throws(() => parseProfile({ ...profile, port }));
  assert.throws(() => parseProfile({ ...profile, host: "robot\nlocalhost" }));
  assert.equal(presets[2].auth.kind, "agent");
  assert.equal(presets[2].user, "");
  assert.equal(presets[2].remotePath, "");
});
