// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { BrowserWindow, dialog, MessageChannelMain, MessagePortMain, shell } from "electron";
import path from "node:path";
import { LogManagerState, RobotProfile } from "../../../shared/LogManager";
import {
  DOWNLOAD_ROBORIO_PASSWORD,
  DOWNLOAD_ROBORIO_USERNAME,
  DOWNLOAD_SYSTEMCORE_PASSWORD,
  DOWNLOAD_SYSTEMCORE_USERNAME,
  WINDOW_ICON
} from "../ElectronConstants";
import { LogLibrary } from "./Library";
import { parseProfile, ProfileStore } from "./Profiles";
import { RemoteSession } from "./Remote";

type PromptKind = "trust" | "password" | "passphrase" | "rename" | "tags";

export class LogManagerWindow {
  private window: BrowserWindow | null = null;

  constructor(
    private library: LogLibrary,
    private profiles: ProfileStore,
    private knownHostsPath: string,
    private openFile: (filename: string, parent: BrowserWindow) => void
  ) {}

  open(parent: BrowserWindow) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 1280,
      height: 850,
      minWidth: 950,
      minHeight: 640,
      show: false,
      icon: WINDOW_ICON,
      webPreferences: { preload: path.join(__dirname, "preload.js") }
    });
    this.window = window;
    window.setMenu(null);
    window.once("ready-to-show", () => window.show());
    let port: MessagePortMain | undefined;
    let remote: RemoteSession | undefined;
    let activeProfile: RobotProfile | undefined;
    let connecting = false;
    let transfer: AbortController | undefined;
    let polling = false;
    let promptSequence = 0;
    const prompts = new Map<string, (value: string | null) => void>();
    const secrets = new Map<string, string>();
    let commands = Promise.resolve();
    const send = (name: string, data?: unknown) => {
      if (!window.isDestroyed()) port?.postMessage({ name, data });
    };
    const activity = (text: string, error = false, progress?: number) => {
      for (const secret of secrets.values()) {
        if (secret) text = text.split(secret).join("[redacted]");
      }
      send("activity", { text, error, progress });
    };
    const fail = (error: unknown) => activity(error instanceof Error ? error.message : String(error), true);
    const prompt = (kind: PromptKind, title: string, detail: string, value?: string) =>
      new Promise<string | null>((resolve) => {
        const id = String(++promptSequence);
        prompts.set(id, resolve);
        send("prompt", { id, kind, title, detail, value });
      });
    const disconnect = () => {
      transfer?.abort();
      remote?.close();
      remote = undefined;
      activeProfile = undefined;
      connecting = false;
      prompts.forEach((resolve) => resolve(null));
      prompts.clear();
      send("remote", { status: "disconnected", files: [] });
    };
    const refresh = async () => {
      const state: LogManagerState = {
        profiles: this.profiles.load(),
        folders: [...this.library.folders],
        downloadFolder: this.library.downloadFolder,
        library: await this.library.list()
      };
      send("state", state);
    };
    let refreshTimer: NodeJS.Timeout | undefined;
    this.library.onMetadataChanged = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh().catch(fail);
      }, 100);
    };
    const poll = async () => {
      const session = remote;
      if (!session || connecting || polling) return;
      polling = true;
      try {
        const files = await session.list();
        let disk;
        let diskError;
        try {
          disk = await session.diskUsage();
        } catch (error) {
          diskError = "Disk usage unavailable: " + (error instanceof Error ? error.message : String(error));
          if (remote === session) activity(diskError, true);
        }
        if (remote === session) {
          send("remote", { status: "connected", profileId: activeProfile?.id, files, disk, error: diskError });
        }
      } catch (error) {
        if (remote === session) fail(error);
      } finally {
        polling = false;
      }
    };
    const connect = async (input: unknown) => {
      if (transfer || connecting) throw new Error("Finish or cancel the current operation first.");
      disconnect();
      const profile = parseProfile(input);
      const session = new RemoteSession(this.knownHostsPath, {
        roborio: { user: DOWNLOAD_ROBORIO_USERNAME, password: DOWNLOAD_ROBORIO_PASSWORD },
        systemcore: { user: DOWNLOAD_SYSTEMCORE_USERNAME, password: DOWNLOAD_SYSTEMCORE_PASSWORD }
      });
      remote = session;
      activeProfile = profile;
      connecting = true;
      send("remote", { status: "connecting", profileId: profile.id, files: [] });
      try {
        await session.connect(
          profile,
          {
            trustHost: async (info) =>
              (await prompt(
                "trust",
                "Trust this robot's host key?",
                `${info.host}:${info.port}\n${info.fingerprint}\nVerify this fingerprint with the robot administrator before trusting it.`
              )) === "trust",
            secret: async (kind) => {
              const key = JSON.stringify([profile.host, profile.port, profile.user, profile.auth, kind]);
              if (secrets.has(key)) return secrets.get(key);
              const value = await prompt(
                kind,
                kind === "password" ? "Robot password" : "Private key passphrase",
                `${profile.user}@${profile.host}:${profile.port}\nKept in memory until this window closes.`
              );
              if (value !== null) secrets.set(key, value);
              return value ?? undefined;
            }
          },
          () => {
            if (remote === session) {
              remote = undefined;
              connecting = false;
              transfer?.abort();
              send("remote", { status: "disconnected", files: [], error: "SSH connection closed." });
            }
          }
        );
        if (remote !== session) return;
        connecting = false;
        activity(`Connected to ${profile.name} (${profile.host}:${profile.port}).`);
        await poll();
      } catch (error) {
        if (remote === session) disconnect();
        fail(error);
        secrets.clear();
      }
    };
    const entryFor = async (input: unknown) => {
      if (typeof input !== "string") throw new Error("Select a library entry.");
      const entry = (await this.library.list()).find((entry) => entry.path === input);
      if (!entry) throw new Error("This file is not in the library. Refresh and try again.");
      return entry;
    };
    const handle = async (name: string, data: unknown) => {
      switch (name) {
        case "ready":
        case "refresh-local":
          await refresh();
          break;
        case "save-profile": {
          const profile = parseProfile(data);
          const profiles = this.profiles.load().filter((item) => item.id !== profile.id);
          this.profiles.save([...profiles, profile]);
          await refresh();
          activity(`Saved profile ${profile.name}.`);
          break;
        }
        case "refresh-remote":
          await poll();
          break;
        case "sync": {
          if (!remote || connecting) throw new Error("Connect to a robot first.");
          if (transfer) throw new Error("A sync is already running.");
          if (!data || typeof data !== "object" || !("names" in data)) throw new Error("Select remote logs.");
          const names = data.names;
          if (names !== null && (!Array.isArray(names) || !names.every((name) => typeof name === "string"))) {
            throw new Error("Invalid remote selection.");
          }
          const session = remote;
          const robot = activeProfile!.name;
          const controller = new AbortController();
          transfer = controller;
          send("busy", true);
          try {
            const selected = names === null ? (await session.list()).map((file) => file.name) : names;
            activity(`Sync started. ${selected.length} log(s) selected.`);
            const folder = this.library.downloadFolder;
            const result = await session.sync(selected, folder, controller.signal, (event) => {
              if (event.state === "finished") this.library.addDownloaded(path.join(folder, event.name), robot);
              activity(
                `${event.name}: ${
                  event.state
                } (${event.current.toLocaleString()} / ${event.total.toLocaleString()} bytes)`,
                false,
                event.total ? event.current / event.total : 0
              );
            });
            activity(
              `Sync finished. Downloaded ${result.downloaded.length}, skipped ${result.skipped.length}.`,
              false,
              1
            );
          } finally {
            transfer = undefined;
            send("busy", false);
            await refresh();
            await poll();
          }
          break;
        }
        case "choose-download-folder":
        case "add-folder": {
          const result = await dialog.showOpenDialog(window, {
            title: name === "add-folder" ? "Add a log library folder" : "Choose where downloaded logs are saved",
            defaultPath: this.library.downloadFolder,
            properties: ["openDirectory", "createDirectory"]
          });
          if (!result.canceled && result.filePaths[0]) {
            if (name === "add-folder") this.library.addFolder(result.filePaths[0]);
            else this.library.setDownloadFolder(result.filePaths[0]);
            await refresh();
          }
          break;
        }
        case "remove-folder":
          if (typeof data !== "string") throw new Error("Choose a library folder.");
          this.library.removeFolder(data);
          await refresh();
          break;
        case "choose-key": {
          const result = await dialog.showOpenDialog(window, {
            title: "Select a private SSH key",
            properties: ["openFile"]
          });
          if (!result.canceled && result.filePaths[0]) send("key-path", result.filePaths[0]);
          break;
        }
        case "open": {
          const entry = await entryFor(data);
          if (entry.missing) throw new Error("This log is missing. Restore the file or remove it from the list.");
          this.openFile(entry.path, parent);
          break;
        }
        case "reveal": {
          const entry = await entryFor(data);
          shell.showItemInFolder(entry.path);
          break;
        }
        case "rename": {
          const entry = await entryFor(data);
          if (entry.readOnly || entry.missing) throw new Error("This entry cannot be renamed.");
          const value = await prompt(
            "rename",
            "Rename log",
            "Enter the new file name, including its extension.",
            entry.name
          );
          if (value !== null) await this.library.rename(entry.path, value);
          await refresh();
          break;
        }
        case "tags": {
          const entry = await entryFor(data);
          if (entry.readOnly) throw new Error("The built-in sample is read-only.");
          const value = await prompt("tags", "Edit tags", "Separate tags with commas.", entry.tags.join(", "));
          if (value !== null)
            this.library.setTags(
              entry.path,
              value
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean)
            );
          await refresh();
          break;
        }
        case "trash": {
          const entry = await entryFor(data);
          if (entry.readOnly || entry.missing) throw new Error("This entry cannot be moved to the trash.");
          const result = await dialog.showMessageBox(window, {
            type: "warning",
            message: `Move ${entry.name} to the trash?`,
            detail: entry.path,
            buttons: ["Cancel", "Move to Trash"],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          });
          if (result.response === 1) await this.library.trash(entry.path);
          await refresh();
          break;
        }
        case "remove-missing": {
          const entry = await entryFor(data);
          this.library.removeMissing(entry.path);
          await refresh();
          break;
        }
        default:
          throw new Error("Unknown Log Manager action.");
      }
    };
    const interval = setInterval(() => void poll(), 5000);
    window.webContents.on("dom-ready", () => {
      disconnect();
      secrets.clear();
      port?.close();
      const channel = new MessageChannelMain();
      port = channel.port2;
      port.on("message", (event) => {
        const message = event.data;
        if (!message || typeof message.name !== "string") return;
        if (message.name === "prompt-response") {
          const data = message.data;
          if (data && typeof data.id === "string" && (data.value === null || typeof data.value === "string")) {
            prompts.get(data.id)?.(data.value);
            prompts.delete(data.id);
          }
          return;
        }
        if (message.name === "cancel" || message.name === "disconnect") {
          if (message.name === "disconnect" || connecting) disconnect();
          else transfer?.abort();
          return;
        }
        if (message.name === "connect") {
          void connect(message.data).catch(fail);
          return;
        }
        commands = commands.then(() => handle(message.name, message.data)).catch(fail);
      });
      port.start();
      window.webContents.postMessage("port", null, [channel.port1]);
    });
    window.once("closed", () => {
      clearInterval(interval);
      clearTimeout(refreshTimer);
      this.library.onMetadataChanged = undefined;
      disconnect();
      secrets.clear();
      port?.close();
      this.window = null;
    });
    void window.loadFile(path.join(__dirname, "../www/logManager.html"));
  }
}
