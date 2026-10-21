// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import checkDiskSpace from "check-disk-space";
import { FileHandle, open } from "node:fs/promises";
import path from "node:path";
import { WPILOGEncoder, WPILOGEncoderRecord } from "../../hub/dataSources/wpilog/WPILOGEncoder";
import LoggableType from "../log/LoggableType";
import { RecordingSample, RecordingStatus, RecordingWriter, recordingSampleSize } from "./RecordingWriter";

export interface WPILOGRecordingOptions {
  checkFreeSpace?: (directory: string) => Promise<number>;
  minimumFreeBytes?: number;
  checkIntervalMs?: number;
  maxPendingBytes?: number;
}

class LowDiskError extends Error {
  constructor() {
    super("Recording stopped because disk space is low.");
  }
}

interface Entry {
  id: number;
  type: string;
  metadata: string;
}

type StopResult = { reason: "manual" | "low-disk"; message: string } | { reason: "error"; message: string };

export default class WPILOGRecordingWriter implements RecordingWriter {
  private file: FileHandle | null = null;
  private entries = new Map<string, Entry>();
  private nextEntryId = 1;
  private pendingBytes = 0;
  private completeBytes = 0;
  private tail: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkingDisk = false;
  private generation = 0;
  private failure: StopResult | null = null;
  private status: RecordingStatus;
  private readonly checkFreeSpace: (directory: string) => Promise<number>;
  private readonly minimumFreeBytes: number;
  private readonly checkIntervalMs: number;
  private readonly maxPendingBytes: number;

  constructor(
    private readonly destination: string,
    private readonly onStatus: (status: RecordingStatus) => void = () => {},
    options: WPILOGRecordingOptions = {}
  ) {
    this.checkFreeSpace = options.checkFreeSpace ?? (async (directory) => (await checkDiskSpace(directory)).free);
    this.minimumFreeBytes = options.minimumFreeBytes ?? 64 * 1024 * 1024;
    this.checkIntervalMs = options.checkIntervalMs ?? 1000;
    this.maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
    this.status = { kind: "idle", path: destination, bytesWritten: 0 };
  }

  getStatus(): RecordingStatus {
    return { ...this.status };
  }

  private publish(status: RecordingStatus) {
    this.status = status;
    this.onStatus(this.getStatus());
  }

  start(): Promise<void> {
    if (["starting", "recording", "stopping"].includes(this.status.kind)) {
      return Promise.reject(new Error("A recording is already active."));
    }
    this.generation++;
    this.checkingDisk = false;
    this.entries.clear();
    this.nextEntryId = 1;
    this.pendingBytes = 0;
    this.completeBytes = 0;
    this.tail = Promise.resolve();
    this.closing = null;
    this.failure = null;
    this.publish({ kind: "starting", path: this.destination, bytesWritten: 0 });
    const operation = (async () => {
      await this.requireSpace();
      if (this.status.kind !== "starting") return;
      this.file = await open(this.destination, "w");
      const header = new WPILOGEncoder("TerraScope continuous recording").getEncoded();
      await this.append(header);
      if (this.status.kind !== "starting") return;
      this.publish({ ...this.status, kind: "recording" });
      this.timer = setInterval(() => void this.checkDisk(), this.checkIntervalMs);
      this.timer.unref();
    })();
    this.tail = operation.catch((error) => {
      this.failure = this.resultFor(error);
    });
    return operation.catch(async (error) => {
      await this.finish(this.resultFor(error));
      throw error;
    });
  }

  write(samples: readonly RecordingSample[]): Promise<void> {
    if (this.status.kind !== "recording") return Promise.reject(new Error("Recording is not active."));
    const estimate = samples.reduce((size, sample) => size + recordingSampleSize(sample), 0);
    if (estimate + this.pendingBytes > this.maxPendingBytes) {
      const error = new Error("Recording stopped because storage could not keep up with incoming data.");
      void this.finish(this.resultFor(error));
      return Promise.reject(error);
    }
    let chunks: Uint8Array[];
    try {
      chunks = samples.flatMap((sample) => this.encode(sample));
    } catch (error) {
      void this.finish(this.resultFor(error));
      return Promise.reject(error);
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    this.pendingBytes += size;
    const operation = this.tail.then(async () => {
      if (this.failure !== null) throw new Error(this.failure.message);
      await this.requireSpace();
      for (const chunk of chunks) await this.append(chunk);
      this.publish({ ...this.status, bytesWritten: this.status.bytesWritten });
    });
    this.tail = operation
      .catch((error) => {
        this.failure ??= this.resultFor(error);
      })
      .finally(() => {
        this.pendingBytes -= size;
      });
    return operation.catch(async (error) => {
      await this.finish(this.resultFor(error));
      throw error;
    });
  }

  stop(): Promise<void> {
    return this.finish({ reason: "manual", message: "Recording saved." });
  }

  private async requireSpace() {
    const free = await this.checkFreeSpace(path.dirname(path.resolve(this.destination)));
    if (!Number.isFinite(free) || free < this.minimumFreeBytes) throw new LowDiskError();
  }

  private async checkDisk() {
    if (this.checkingDisk || this.status.kind !== "recording") return;
    this.checkingDisk = true;
    const generation = this.generation;
    try {
      await this.requireSpace();
    } catch (error) {
      if (generation === this.generation && this.status.kind === "recording") {
        await this.finish(this.resultFor(error));
      }
    } finally {
      if (generation === this.generation) this.checkingDisk = false;
    }
  }

  private resultFor(error: unknown): StopResult {
    if (error instanceof LowDiskError) return { reason: "low-disk", message: error.message };
    const message = error instanceof Error ? error.message : String(error);
    return { reason: "error", message: "Recording stopped. " + message };
  }

  private finish(result: StopResult): Promise<void> {
    if (this.closing !== null) return this.closing;
    if (this.status.kind === "idle" || this.status.kind === "stopped" || this.status.kind === "error") {
      return Promise.resolve();
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.publish({ ...this.status, kind: "stopping" });
    this.closing = (async () => {
      await this.tail;
      let outcome = this.failure ?? result;
      const file = this.file;
      this.file = null;
      if (file !== null) {
        try {
          if (this.status.bytesWritten !== this.completeBytes) {
            await file.truncate(this.completeBytes);
            this.status = { ...this.status, bytesWritten: this.completeBytes };
          }
          await file.sync();
        } catch (error) {
          outcome = this.resultFor(error);
        } finally {
          try {
            await file.close();
          } catch (error) {
            outcome = this.resultFor(error);
          }
        }
      }
      const progress = { path: this.destination, bytesWritten: this.status.bytesWritten };
      if (outcome.reason === "error") this.publish({ ...progress, kind: "error", message: outcome.message });
      else this.publish({ ...progress, kind: "stopped", reason: outcome.reason, message: outcome.message });
    })();
    return this.closing;
  }

  private async append(bytes: Uint8Array) {
    if (this.file === null) throw new Error("Recording file is closed.");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await this.file.write(bytes, offset, bytes.byteLength - offset);
      if (bytesWritten === 0) throw new Error("Storage accepted no data.");
      offset += bytesWritten;
      this.status = { ...this.status, bytesWritten: this.status.bytesWritten + bytesWritten };
    }
    this.completeBytes = this.status.bytesWritten;
  }

  private encode(sample: RecordingSample): Uint8Array[] {
    const timestamp = Math.round(sample.timestamp * 1e6);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error("A sample has an invalid WPILOG timestamp.");
    const originalType =
      sample.wpilibType ?? ["raw", "boolean", "double", "string", "boolean[]", "double[]", "string[]"][sample.type];
    const type = originalType === "int" ? "int64" : originalType === "int[]" ? "int64[]" : originalType;
    let entry = this.entries.get(sample.key);
    const records: WPILOGEncoderRecord[] = [];
    if (entry === undefined || entry.type !== type) {
      entry = { id: this.nextEntryId++, type, metadata: sample.metadata };
      this.entries.set(sample.key, entry);
      records.push(
        WPILOGEncoderRecord.makeControlStart(timestamp, {
          entry: entry.id,
          name: sample.key,
          type,
          metadata: sample.metadata
        })
      );
    } else if (entry.metadata !== sample.metadata) {
      entry.metadata = sample.metadata;
      records.push(
        WPILOGEncoderRecord.makeControlSetMetadata(timestamp, { entry: entry.id, metadata: sample.metadata })
      );
    }
    const id = entry.id;
    switch (sample.type) {
      case LoggableType.Raw:
        records.push(WPILOGEncoderRecord.makeRaw(id, timestamp, sample.value));
        break;
      case LoggableType.Boolean:
        records.push(WPILOGEncoderRecord.makeBoolean(id, timestamp, sample.value));
        break;
      case LoggableType.Number:
        records.push(
          (type === "int" || type === "int64"
            ? WPILOGEncoderRecord.makeInteger
            : type === "float"
            ? WPILOGEncoderRecord.makeFloat
            : WPILOGEncoderRecord.makeDouble)(id, timestamp, sample.value)
        );
        break;
      case LoggableType.String:
        records.push(WPILOGEncoderRecord.makeString(id, timestamp, sample.value));
        break;
      case LoggableType.BooleanArray:
        records.push(WPILOGEncoderRecord.makeBooleanArray(id, timestamp, sample.value));
        break;
      case LoggableType.NumberArray:
        records.push(
          (type === "int[]" || type === "int64[]"
            ? WPILOGEncoderRecord.makeIntegerArray
            : type === "float[]"
            ? WPILOGEncoderRecord.makeFloatArray
            : WPILOGEncoderRecord.makeDoubleArray)(id, timestamp, sample.value)
        );
        break;
      case LoggableType.StringArray:
        records.push(WPILOGEncoderRecord.makeStringArray(id, timestamp, sample.value));
        break;
    }
    return records.map((record) => record.getEncoded());
  }
}
