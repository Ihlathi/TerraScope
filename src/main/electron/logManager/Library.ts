// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import fs from "node:fs";
import path from "node:path";
import { LibraryEntry, LogMetadata } from "../../../shared/LogManager";
import { readers } from "../../../shared/plugins/readers";

interface IndexedLog {
  tags: string[];
  robot?: string;
  metadata?: { size: number; mtime: number; value: LogMetadata };
}

interface LibraryIndex {
  version: 1;
  folders: string[];
  downloadFolder: string;
  entries: Record<string, IndexedLog>;
}

function absolute(file: string): string {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
    throw new Error("A full local path is required.");
  }
  return path.resolve(file);
}

function format(file: string): string | undefined {
  const extension = path.extname(file).slice(1).toLowerCase();
  return readers.find((reader) => reader.extensions.includes(extension)) ? extension.toUpperCase() : undefined;
}

function parseIndex(raw: unknown): LibraryIndex {
  if (typeof raw !== "object" || raw === null) throw new Error("Invalid log library index.");
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !Array.isArray(value.folders) ||
    !value.folders.every((folder) => typeof folder === "string") ||
    typeof value.downloadFolder !== "string" ||
    typeof value.entries !== "object" ||
    value.entries === null ||
    Array.isArray(value.entries)
  ) {
    throw new Error("Invalid log library index.");
  }
  const entries: Record<string, IndexedLog> = Object.create(null);
  for (const [file, rawEntry] of Object.entries(value.entries)) {
    absolute(file);
    if (typeof rawEntry !== "object" || rawEntry === null) throw new Error("Invalid log library entry.");
    const entry = rawEntry as Record<string, unknown>;
    if (!Array.isArray(entry.tags) || !entry.tags.every((tag) => typeof tag === "string")) {
      throw new Error("Invalid log library tags.");
    }
    if (entry.robot !== undefined && typeof entry.robot !== "string") throw new Error("Invalid robot name.");
    const parsed: IndexedLog = { tags: entry.tags, robot: entry.robot as string | undefined };
    if (entry.metadata !== undefined) {
      const metadata = entry.metadata as Record<string, unknown>;
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        typeof metadata.size !== "number" ||
        typeof metadata.mtime !== "number" ||
        typeof metadata.value !== "object" ||
        metadata.value === null
      ) {
        throw new Error("Invalid log metadata cache.");
      }
      const cached = metadata.value as Record<string, unknown>;
      const result: LogMetadata = {};
      for (const key of ["robot", "error"] as const) {
        if (cached[key] !== undefined && typeof cached[key] !== "string") throw new Error("Invalid cached metadata.");
        if (typeof cached[key] === "string") result[key] = cached[key];
      }
      for (const key of ["date", "duration"] as const) {
        if (cached[key] !== undefined && (typeof cached[key] !== "number" || !Number.isFinite(cached[key]))) {
          throw new Error("Invalid cached metadata.");
        }
        if (typeof cached[key] === "number") result[key] = cached[key];
      }
      parsed.metadata = { size: metadata.size, mtime: metadata.mtime, value: result };
    }
    entries[absolute(file)] = parsed;
  }
  const folders = [...new Set(value.folders.map(absolute))];
  const downloadFolder = absolute(value.downloadFolder);
  if (!folders.includes(downloadFolder)) folders.push(downloadFolder);
  return { version: 1, folders, downloadFolder, entries };
}

export class LogLibrary {
  private index: LibraryIndex;
  private sample: string;
  onMetadataChanged?: () => void;
  private metadataQueue: { file: string; size: number; mtime: number; indexed: IndexedLog }[] = [];
  private pendingMetadata = new Set<string>();
  private extracting = false;

  constructor(
    private indexPath: string,
    defaultFolder: string,
    samplePath: string,
    private trashFile: (file: string) => Promise<void>,
    private extract: (file: string) => Promise<LogMetadata> = async () => ({})
  ) {
    this.sample = absolute(samplePath);
    defaultFolder = absolute(defaultFolder);
    if (fs.existsSync(indexPath)) {
      try {
        this.index = parseIndex(JSON.parse(fs.readFileSync(indexPath, "utf8")));
      } catch (error) {
        throw new Error(`Cannot read the log library index at ${indexPath}. ${String(error)}`);
      }
    } else {
      this.index = {
        version: 1,
        folders: [defaultFolder],
        downloadFolder: defaultFolder,
        entries: Object.create(null)
      };
      fs.mkdirSync(defaultFolder, { recursive: true });
      this.save();
    }
    this.index.entries[this.sample] ??= { tags: [] };
  }

  get folders(): string[] {
    return [...this.index.folders];
  }

  get downloadFolder(): string {
    return this.index.downloadFolder;
  }

  setDownloadFolder(folder: string): void {
    folder = this.checkFolder(folder);
    if (!this.index.folders.includes(folder)) this.index.folders.push(folder);
    this.index.downloadFolder = folder;
    this.save();
  }

  addFolder(folder: string): void {
    folder = this.checkFolder(folder);
    if (!this.index.folders.includes(folder)) {
      this.index.folders.push(folder);
      this.save();
    }
  }

  removeFolder(folder: string): void {
    folder = absolute(folder);
    if (folder === this.index.downloadFolder) throw new Error("Choose a different download folder first.");
    this.index.folders = this.index.folders.filter((item) => item !== folder);
    this.save();
  }

  private checkFolder(folder: string): string {
    folder = absolute(folder);
    fs.mkdirSync(folder, { recursive: true });
    if (!fs.statSync(folder).isDirectory()) throw new Error("The library folder must be a directory.");
    return folder;
  }

  addOpened(file: string): void {
    file = absolute(file);
    if (!format(file)) throw new Error("This log format is not supported.");
    if (this.isSample(file)) return;
    if (!Object.hasOwn(this.index.entries, file)) {
      this.index.entries[file] = { tags: [] };
      this.save();
    }
  }

  addDownloaded(file: string, profileName: string): void {
    this.addOpened(file);
    file = absolute(file);
    this.assertMutable(file);
    this.index.entries[file].robot = profileName;
    this.save();
  }

  async list(): Promise<LibraryEntry[]> {
    let discovered = false;
    for (const folder of this.index.folders) {
      try {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          if (!entry.isFile() || !format(entry.name)) continue;
          const file = path.join(folder, entry.name);
          if (this.isSample(file) || Object.hasOwn(this.index.entries, file)) continue;
          this.index.entries[file] = { tags: [] };
          discovered = true;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }
    }
    if (discovered) this.save();
    const rows: LibraryEntry[] = [];
    for (const file of [this.sample, ...Object.keys(this.index.entries).filter((file) => file !== this.sample)]) {
      const indexed = this.index.entries[file];
      const readOnly = this.isSample(file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error("The log path is not a regular file.");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        rows.push({
          ...indexed?.metadata?.value,
          path: file,
          name: readOnly ? "TerraScope sample robot" : path.basename(file),
          tags: indexed?.tags ?? [],
          robot: indexed?.metadata?.value.robot || (readOnly ? "TerraScope sample robot" : indexed?.robot),
          readOnly,
          missing: code === "ENOENT" || code === "ENOTDIR",
          size: indexed?.metadata?.size ?? 0,
          mtime: indexed?.metadata?.mtime ?? 0,
          format: format(file) ?? "",
          error: code === "ENOENT" || code === "ENOTDIR" ? undefined : String(error)
        });
        continue;
      }
      const signature = { size: stat.size, mtime: stat.mtimeMs };
      let metadata = indexed?.metadata;
      if (metadata?.size !== signature.size || metadata.mtime !== signature.mtime) {
        metadata = { ...signature, value: {} };
        if (indexed && !this.pendingMetadata.has(file)) {
          this.pendingMetadata.add(file);
          this.metadataQueue.push({ file, ...signature, indexed });
          this.pumpMetadata();
        }
      }
      rows.push({
        ...metadata.value,
        path: file,
        name: readOnly ? "TerraScope sample robot" : path.basename(file),
        robot: metadata.value.robot || (readOnly ? "TerraScope sample robot" : indexed?.robot),
        tags: readOnly ? [] : [...(indexed?.tags ?? [])],
        readOnly,
        missing: false,
        ...signature,
        format: format(file) ?? "",
        error: metadata.value.error
      });
    }
    return rows;
  }

  async rename(file: string, newName: string): Promise<void> {
    file = absolute(file);
    this.assertMutable(file);
    if (
      typeof newName !== "string" ||
      !newName.trim() ||
      newName === "." ||
      newName === ".." ||
      /[<>:"/\\|?*\x00-\x1f]/.test(newName) ||
      /[. ]$/.test(newName) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(newName)
    ) {
      throw new Error("Enter a valid file name without a folder path.");
    }
    if (!format(newName)) throw new Error("Keep a supported log extension.");
    const target = path.join(path.dirname(file), newName);
    if (target === file) return;
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile()) throw new Error("Only regular log files can be renamed.");
    await fs.promises.link(file, target);
    try {
      await fs.promises.unlink(file);
    } catch (error) {
      await fs.promises.unlink(target);
      throw error;
    }
    this.index.entries[target] = this.index.entries[file];
    delete this.index.entries[file];
    this.save();
  }

  setTags(file: string, tags: string[]): void {
    file = absolute(file);
    this.assertMutable(file);
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || tag.length > 100)) {
      throw new Error("Tags must be text, with at most 100 characters per tag.");
    }
    this.index.entries[file].tags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    this.save();
  }

  async trash(file: string): Promise<void> {
    file = absolute(file);
    this.assertMutable(file);
    if (!(await fs.promises.lstat(file)).isFile()) throw new Error("Only regular log files can be moved to Trash.");
    await this.trashFile(file);
    delete this.index.entries[file];
    this.save();
  }

  removeMissing(file: string): void {
    file = absolute(file);
    this.assertMutable(file);
    try {
      fs.lstatSync(file);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      delete this.index.entries[file];
      this.save();
      return;
    }
    throw new Error("This file still exists. Use Move to Trash instead.");
  }

  private pumpMetadata(): void {
    if (this.extracting) return;
    const task = this.metadataQueue.shift();
    if (!task) return;
    this.extracting = true;
    this.extract(task.file)
      .catch((error): LogMetadata => ({ error: String(error) }))
      .then((value) => {
        if (this.index.entries[task.file] === task.indexed) {
          task.indexed.metadata = { size: task.size, mtime: task.mtime, value };
        }
      })
      .finally(() => {
        this.pendingMetadata.delete(task.file);
        this.extracting = false;
        if (this.metadataQueue.length === 0) {
          try {
            this.save();
          } catch (error) {
            if (task.indexed.metadata) task.indexed.metadata.value.error = `Cannot save log metadata. ${String(error)}`;
          }
        }
        this.pumpMetadata();
        this.onMetadataChanged?.();
      });
  }

  private assertMutable(file: string): void {
    if (this.isSample(file)) throw new Error("The built-in sample is read-only.");
    if (!Object.hasOwn(this.index.entries, file)) throw new Error("The file is not in the log library.");
  }

  private isSample(file: string): boolean {
    if (file === this.sample) return true;
    try {
      const sampleStat = fs.statSync(this.sample);
      const fileStat = fs.statSync(file);
      return sampleStat.dev === fileStat.dev && sampleStat.ino === fileStat.ino;
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
    const temporary = this.indexPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(this.index, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, this.indexPath);
  }
}
