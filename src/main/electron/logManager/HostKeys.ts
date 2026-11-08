// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface HostKeyPrompt {
  host: string;
  port: number;
  fingerprint: string;
}

export function hostFingerprint(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export class HostKeys {
  constructor(private filename: string) {}

  async verify(
    host: string,
    port: number,
    key: Buffer,
    trust: (prompt: HostKeyPrompt) => Promise<boolean>,
    isActive: () => boolean = () => true
  ): Promise<boolean> {
    const hostId = JSON.stringify([host.toLowerCase(), port]);
    const fingerprint = hostFingerprint(key);
    const known = this.read();
    const previous = known[hostId];
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new Error(
          `SSH host key changed for ${host}:${port}. Connection refused.\nTrusted fingerprint: ${previous}\nReceived fingerprint: ${fingerprint}`
        );
      }
      return isActive();
    }
    if (!(await trust({ host, port, fingerprint })) || !isActive()) return false;
    const current = this.read();
    if (current[hostId] !== undefined && current[hostId] !== fingerprint) {
      throw new Error("The trusted host key changed while awaiting confirmation. Connect again.");
    }
    current[hostId] = fingerprint;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + "." + randomUUID() + ".tmp";
    try {
      fs.writeFileSync(temporary, JSON.stringify(current, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return true;
  }

  private read(): Record<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null);
      throw error;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid TerraScope known_hosts file.");
    }
    const result: Record<string, string> = Object.create(null);
    for (const [host, fingerprint] of Object.entries(parsed)) {
      if (typeof fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
        throw new Error("Invalid TerraScope known_hosts fingerprint.");
      }
      result[host] = fingerprint;
    }
    return result;
  }
}
