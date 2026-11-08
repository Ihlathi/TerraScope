// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, ConnectConfig, SFTPWrapper, utils } from "ssh2";
import { RemoteLog, RobotProfile } from "../../../shared/LogManager";
import { readers } from "../../../shared/plugins/readers";
import { HostKeyPrompt, HostKeys } from "./HostKeys";
import { parseProfile, validateRemotePath } from "./Profiles";

export interface RemoteDirectoryEntry {
  filename: string;
  attrs: { size: number; mtime: number; mode: number };
}

export interface ReadOnlySFTP {
  readdir(remotePath: string, callback: (error: Error | undefined, entries: RemoteDirectoryEntry[]) => void): void;
  createReadStream(remotePath: string): Readable;
}

export interface SyncProgress {
  name: string;
  current: number;
  total: number;
  state: "downloading" | "skipped" | "finished";
}

export interface SessionPrompts {
  trustHost(info: HostKeyPrompt): Promise<boolean>;
  secret(kind: "password" | "passphrase"): Promise<string | undefined>;
}

export function safeRemoteName(name: string): boolean {
  return (
    name !== "." &&
    name !== ".." &&
    name.length > 0 &&
    !/[\x00-\x1f\x7f/\\:*?"<>|]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}

export async function listRemoteLogs(sftp: ReadOnlySFTP, directory: string): Promise<RemoteLog[]> {
  const remotePath = validateRemotePath(directory);
  const entries = await new Promise<RemoteDirectoryEntry[]>((resolve, reject) => {
    sftp.readdir(remotePath, (error, files) => (error ? reject(error) : resolve(files)));
  });
  const extensions = new Set(readers.flatMap((reader) => [...reader.extensions]));
  return entries
    .filter(
      (entry) =>
        safeRemoteName(entry.filename) &&
        (entry.attrs.mode & 0o170000) === 0o100000 &&
        Number.isSafeInteger(entry.attrs.size) &&
        entry.attrs.size >= 0 &&
        Number.isFinite(entry.attrs.mtime) &&
        extensions.has(path.posix.extname(entry.filename).slice(1).toLowerCase())
    )
    .map((entry) => ({ name: entry.filename, size: entry.attrs.size, modified: entry.attrs.mtime * 1000 }));
}

async function localStat(filename: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function syncRemoteLogs(
  sftp: ReadOnlySFTP,
  directory: string,
  names: readonly string[],
  localDirectory: string,
  signal: AbortSignal,
  onProgress: (event: SyncProgress) => void
): Promise<{ downloaded: string[]; skipped: string[] }> {
  signal.throwIfAborted();
  if (names.some((name) => !safeRemoteName(name))) throw new Error("Unsafe remote filename.");
  const remotePath = validateRemotePath(directory);
  const listed = new Map((await listRemoteLogs(sftp, remotePath)).map((file) => [file.name, file]));
  const selected = [...new Set(names)].map((name) => {
    const file = listed.get(name);
    if (!file) throw new Error(`Remote log is no longer available: ${name}`);
    return file;
  });
  await fs.promises.mkdir(localDirectory, { recursive: true });
  const destination = await fs.promises.realpath(localDirectory);
  const downloaded: string[] = [];
  const skipped: string[] = [];
  for (const file of selected) {
    signal.throwIfAborted();
    const finalPath = path.join(destination, file.name);
    const existing = await localStat(finalPath);
    if (existing) {
      if (!existing.isFile() || existing.size !== file.size)
        throw new Error(`Local file already exists with a different size or type: ${file.name}`);
      skipped.push(finalPath);
      onProgress({ name: file.name, current: file.size, total: file.size, state: "skipped" });
      continue;
    }
    const temporary = path.join(destination, `.terrascope-${randomUUID()}.part`);
    try {
      const source = sftp.createReadStream(path.posix.join(remotePath, file.name));
      let current = 0;
      source.on("data", (chunk: Buffer) => {
        current += chunk.length;
        if (current > file.size) source.destroy(new Error(`Remote file grew during download: ${file.name}`));
        onProgress({ name: file.name, current, total: file.size, state: "downloading" });
      });
      await pipeline(source, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
      const written = await fs.promises.stat(temporary);
      if (written.size !== file.size)
        throw new Error(
          `Downloaded size does not match ${file.name}: expected ${file.size}, received ${written.size}.`
        );
      signal.throwIfAborted();
      if (await localStat(finalPath)) throw new Error(`Local file appeared during download: ${file.name}`);
      signal.throwIfAborted();
      await fs.promises.link(temporary, finalPath);
      downloaded.push(finalPath);
      onProgress({ name: file.name, current: file.size, total: file.size, state: "finished" });
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }
  return { downloaded, skipped };
}

export const DISK_USAGE_COMMAND = "LC_ALL=C xargs -0 df -Pk --";

export function parseDiskUsage(output: string): { total: number; used: number; available: number } {
  for (const line of output.trim().split("\n").reverse()) {
    const match = line.match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s/);
    if (!match) continue;
    const [total, used, available] = match.slice(1).map((value) => Number(value) * 1024);
    if ([total, used, available].every(Number.isSafeInteger)) return { total, used, available };
  }
  throw new Error("Could not read remote disk usage.");
}

export class RemoteSession {
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;
  private profile: RobotProfile | null = null;
  private lifetime = new AbortController();
  private syncing = false;
  private hostKeys: HostKeys;

  constructor(
    knownHostsPath: string,
    private factoryCredentials: {
      roborio: { user: string; password: string };
      systemcore: { user: string; password: string };
    }
  ) {
    this.hostKeys = new HostKeys(knownHostsPath);
  }

  async connect(profileInput: RobotProfile, prompts: SessionPrompts, onClose?: () => void): Promise<void> {
    this.close();
    const lifetime = (this.lifetime = new AbortController());
    const profile = parseProfile(profileInput);
    if (!profile.host || !profile.user || !profile.remotePath)
      throw new Error("Fill in the host, user, and remote log directory.");
    const base: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.user,
      readyTimeout: 120000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 3
    };
    let agents: (string | undefined)[] = [undefined];
    switch (profile.auth.kind) {
      case "factory":
        base.password = this.factoryCredentials[profile.auth.preset].password;
        break;
      case "password":
        base.password = await prompts.secret("password");
        if (base.password === undefined) throw new Error("Connection canceled.");
        break;
      case "key": {
        if (!path.isAbsolute(profile.auth.keyPath)) throw new Error("Select an absolute private key file path.");
        const privateKey = await fs.promises.readFile(profile.auth.keyPath);
        let parsed = utils.parseKey(privateKey);
        if (parsed instanceof Error && /encrypted|passphrase/i.test(parsed.message)) {
          const passphrase = await prompts.secret("passphrase");
          if (passphrase === undefined) throw new Error("Connection canceled.");
          parsed = utils.parseKey(privateKey, passphrase);
          base.passphrase = passphrase;
        }
        if (parsed instanceof Error) throw new Error("Unable to read private key. Check the key file and passphrase.");
        base.privateKey = privateKey;
        break;
      }
      case "agent":
        agents =
          process.platform === "win32" ? ["\\\\.\\pipe\\openssh-ssh-agent", "pageant"] : [process.env.SSH_AUTH_SOCK];
        if (agents[0] === undefined)
          throw new Error("SSH_AUTH_SOCK is not set. Start an ssh-agent or choose another authentication method.");
        break;
    }
    lifetime.signal.throwIfAborted();
    try {
      for (let index = 0; index < agents.length; index++) {
        try {
          await this.connectClient(profile, { ...base, agent: agents[index] }, prompts, lifetime, onClose);
          return;
        } catch (error) {
          lifetime.signal.throwIfAborted();
          this.client?.end();
          this.client = null;
          if (index === agents.length - 1) throw error;
        }
      }
    } finally {
      base.password = undefined;
      base.passphrase = undefined;
      base.privateKey = undefined;
    }
  }

  private async connectClient(
    profile: RobotProfile,
    config: ConnectConfig,
    prompts: SessionPrompts,
    lifetime: AbortController,
    onClose?: () => void
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let verifiedError: Error | undefined;
      let established = false;
      client.on("error", (error) => {
        reject(verifiedError ?? error);
        client.end();
      });
      client.on("close", () => {
        reject(verifiedError ?? new Error("SSH connection closed."));
        if (this.client === client) {
          this.client = null;
          this.sftp = null;
          this.profile = null;
          if (established && !lifetime.signal.aborted) {
            lifetime.abort();
            onClose?.();
          }
        }
      });
      client.once("ready", () => {
        if (lifetime.signal.aborted) return client.end();
        client.sftp((error, sftp) => {
          if (error) {
            client.end();
            reject(error);
            return;
          }
          if (lifetime.signal.aborted) {
            sftp.end();
            client.end();
            return;
          }
          this.sftp = sftp;
          this.profile = profile;
          established = true;
          resolve();
        });
      });
      const active = () => !lifetime.signal.aborted && this.client === client;
      client.connect({
        ...config,
        hostVerifier: (key: Buffer, callback: (accepted: boolean) => void) => {
          this.hostKeys.verify(profile.host, profile.port, key, prompts.trustHost, active).then(
            (accepted) => callback(accepted),
            (error: Error) => {
              verifiedError = error;
              callback(false);
            }
          );
        }
      });
    });
  }

  async list(): Promise<RemoteLog[]> {
    if (!this.sftp || !this.profile) throw new Error("Not connected.");
    return listRemoteLogs(this.sftp, this.profile.remotePath);
  }

  async diskUsage(): Promise<{ total: number; used: number; available: number }> {
    if (!this.client || !this.profile) throw new Error("Not connected.");
    const client = this.client;
    const directory = this.profile.remotePath;
    return new Promise((resolve, reject) => {
      client.exec(DISK_USAGE_COMMAND, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let output = "";
        let errorOutput = "";
        const timer = setTimeout(() => {
          stream.destroy();
          reject(new Error("Remote disk usage timed out."));
        }, 5000);
        stream.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.length > 65536) {
            stream.destroy();
            reject(new Error("Remote disk usage output was too large."));
          }
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          errorOutput = (errorOutput + chunk.toString()).slice(0, 4096);
        });
        stream.once("error", (error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
        stream.once("close", (code: number | null) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(errorOutput || "Remote df failed."));
            return;
          }
          try {
            resolve(parseDiskUsage(output));
          } catch (error) {
            reject(error);
          }
        });
        stream.end(directory + "\0");
      });
    });
  }

  async sync(names: string[], localDirectory: string, signal: AbortSignal, onProgress: (event: SyncProgress) => void) {
    if (!this.sftp || !this.profile) throw new Error("Not connected.");
    if (this.syncing) throw new Error("A sync is already running.");
    this.syncing = true;
    try {
      return await syncRemoteLogs(
        this.sftp,
        this.profile.remotePath,
        names,
        localDirectory,
        AbortSignal.any([signal, this.lifetime.signal]),
        onProgress
      );
    } finally {
      this.syncing = false;
    }
  }

  close(): void {
    this.lifetime.abort();
    this.client?.end();
    this.client = null;
    this.sftp = null;
    this.profile = null;
  }
}
