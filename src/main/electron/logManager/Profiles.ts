// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RobotAuth, RobotProfile } from "../../../shared/LogManager";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid robot profile.");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > 4096) throw new Error(`Invalid ${label}.`);
  return value;
}

export function validateRemotePath(remotePath: string): string {
  if (!path.posix.isAbsolute(remotePath) || remotePath.includes("\0")) {
    throw new Error("The remote log directory must be an absolute Linux path.");
  }
  return path.posix.normalize(remotePath);
}

export function parseProfile(value: unknown): RobotProfile {
  const input = object(value);
  const authInput = object(input.auth);
  let auth: RobotAuth;
  switch (authInput.kind) {
    case "agent":
    case "password":
      auth = { kind: authInput.kind };
      break;
    case "key":
      auth = { kind: "key", keyPath: text(authInput.keyPath, "private key path") };
      break;
    case "factory":
      if (authInput.preset !== "roborio" && authInput.preset !== "systemcore")
        throw new Error("Invalid factory preset.");
      auth = { kind: "factory", preset: authInput.preset };
      break;
    default:
      throw new Error("Invalid authentication method.");
  }
  if (
    typeof input.port !== "number" ||
    !Number.isInteger(input.port) ||
    Number(input.port) < 1 ||
    Number(input.port) > 65535
  ) {
    throw new Error("SSH port must be between 1 and 65535.");
  }
  const host = text(input.host, "host").trim();
  if (/\s/.test(host)) throw new Error("The host must not contain spaces or control characters.");
  const remotePath = text(input.remotePath, "remote directory");
  return {
    id: text(input.id, "profile id"),
    name: text(input.name, "profile name"),
    host,
    port: input.port,
    user: text(input.user, "user").trim(),
    remotePath: remotePath === "" ? "" : validateRemotePath(remotePath),
    auth
  };
}

export function parseProfiles(value: unknown): RobotProfile[] {
  if (!Array.isArray(value)) throw new Error("Invalid robot profiles file.");
  const profiles = value.map(parseProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length)
    throw new Error("Duplicate profile ids.");
  return profiles;
}

export function createPresets(defaults: {
  host: string;
  remotePath: string;
  roborioUser: string;
  systemcoreUser: string;
}): RobotProfile[] {
  return [
    {
      id: "roborio",
      name: "roboRIO",
      host: defaults.host,
      port: 22,
      user: defaults.roborioUser,
      remotePath: defaults.remotePath,
      auth: { kind: "factory", preset: "roborio" }
    },
    {
      id: "systemcore",
      name: "SystemCore",
      host: defaults.host,
      port: 22,
      user: defaults.systemcoreUser,
      remotePath: defaults.remotePath,
      auth: { kind: "factory", preset: "systemcore" }
    },
    {
      id: "linux",
      name: "Linux robot (Orange Pi)",
      host: "",
      port: 22,
      user: "",
      remotePath: "",
      auth: { kind: "agent" }
    }
  ];
}

export class ProfileStore {
  constructor(
    private filename: string,
    private presets: RobotProfile[]
  ) {}

  load(): RobotProfile[] {
    try {
      return parseProfiles(JSON.parse(fs.readFileSync(this.filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return parseProfiles(this.presets);
    }
  }

  save(input: unknown): RobotProfile[] {
    const profiles = parseProfiles(input);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(profiles, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return profiles;
  }
}
