// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import LoggableType from "../../shared/log/LoggableType";
import {
  RecordingSample,
  RecordingStatus,
  RecordingWriter,
  recordingSampleSize
} from "../../shared/recording/RecordingWriter";
import WPILOGRecordingWriter from "../../shared/recording/WPILOGRecordingWriter";

type HostState =
  | { kind: "selecting" | "cancelled" | "finished" }
  | { kind: "starting" | "recording" | "writing" | "stopping"; writer: RecordingWriter };

function isSample(value: unknown): value is RecordingSample {
  if (typeof value !== "object" || value === null) return false;
  const sample = value as Record<string, unknown>;
  if (
    typeof sample.key !== "string" ||
    typeof sample.timestamp !== "number" ||
    !Number.isFinite(sample.timestamp) ||
    sample.timestamp < 0 ||
    (sample.wpilibType !== null && typeof sample.wpilibType !== "string") ||
    typeof sample.metadata !== "string"
  )
    return false;
  switch (sample.type) {
    case LoggableType.Raw:
      return sample.value instanceof Uint8Array;
    case LoggableType.Boolean:
      return typeof sample.value === "boolean";
    case LoggableType.Number:
      return typeof sample.value === "number";
    case LoggableType.String:
      return typeof sample.value === "string";
    case LoggableType.BooleanArray:
      return Array.isArray(sample.value) && sample.value.every((item) => typeof item === "boolean");
    case LoggableType.NumberArray:
      return Array.isArray(sample.value) && sample.value.every((item) => typeof item === "number");
    case LoggableType.StringArray:
      return Array.isArray(sample.value) && sample.value.every((item) => typeof item === "string");
    default:
      return false;
  }
}

export default class LiveRecordingManager {
  private state: HostState = { kind: "selecting" };
  private failure: string | null = null;
  private nextBatch = 1;

  constructor(
    readonly id: number,
    private selectDestination: () => Promise<string | null>,
    private send: (name: string, data: unknown) => void,
    private onFinished: () => void,
    private createWriter: (path: string, onStatus: (status: RecordingStatus) => void) => RecordingWriter = (
      path,
      onStatus
    ) => new WPILOGRecordingWriter(path, onStatus)
  ) {}

  async start() {
    try {
      const path = await this.selectDestination();
      if (this.state.kind !== "selecting") return;
      if (path === null) {
        this.finish({ kind: "idle", path: "", bytesWritten: 0 });
        return;
      }
      const writer = this.createWriter(path, (status) => {
        if (status.kind === "stopped" || status.kind === "error") {
          this.finish(this.failure === null ? status : { ...status, kind: "error", message: this.failure });
        } else {
          if (status.kind === "stopping" && "writer" in this.state) {
            this.state = { kind: "stopping", writer: this.state.writer };
          }
          this.send("recording-status", { id: this.id, status });
        }
      });
      const starting: HostState = { kind: "starting", writer };
      this.state = starting;
      await writer.start();
      if (this.state !== starting) return;
      this.state = { kind: "recording", writer };
      this.send("recording-ready", { id: this.id, path });
    } catch (error) {
      if (this.state.kind !== "finished") this.fail(error);
    }
  }

  async write(batch: unknown, samples: unknown) {
    if (this.state.kind === "finished" || this.state.kind === "cancelled" || this.state.kind === "stopping") return;
    if (
      this.state.kind !== "recording" ||
      typeof batch !== "number" ||
      !Number.isSafeInteger(batch) ||
      batch !== this.nextBatch ||
      !Array.isArray(samples) ||
      samples.length > 32768 ||
      !samples.every(isSample) ||
      samples.reduce((size, sample) => size + recordingSampleSize(sample), 0) > 4 * 1024 * 1024
    ) {
      await this.abort("Recording stopped after an invalid or oversized data batch.");
      return;
    }
    const writer = this.state.writer;
    this.nextBatch++;
    const writing: HostState = { kind: "writing", writer };
    this.state = writing;
    try {
      await writer.write(samples);
      if (this.state !== writing) return;
      this.state = { kind: "recording", writer };
      this.send("recording-ack", { id: this.id, batch });
    } catch (error) {
      if (this.state !== writing) return;
      await this.abort(error instanceof Error ? error.message : String(error));
    }
  }

  async stop() {
    if (this.state.kind === "selecting") {
      this.state = { kind: "cancelled" };
      this.finish({ kind: "idle", path: "", bytesWritten: 0 });
      return;
    }
    if (!("writer" in this.state)) return;
    const writer = this.state.writer;
    const stopping: HostState = { kind: "stopping", writer };
    this.state = stopping;
    try {
      await writer.stop();
      if (this.state === stopping) this.finish(writer.getStatus());
    } catch (error) {
      this.fail(error);
    }
  }

  requestStop() {
    this.send("recording-request-stop", { id: this.id });
  }

  async abort(message: string) {
    this.failure = message;
    const progress = "writer" in this.state ? this.state.writer.getStatus() : { path: "", bytesWritten: 0 };
    if ("writer" in this.state) {
      const writer = this.state.writer;
      this.state = { kind: "stopping", writer };
      try {
        await writer.stop();
      } catch {}
    }
    this.finish({ kind: "error", path: progress.path, bytesWritten: progress.bytesWritten, message });
  }

  private fail(error: unknown) {
    const progress = "writer" in this.state ? this.state.writer.getStatus() : { path: "", bytesWritten: 0 };
    this.finish({
      kind: "error",
      path: progress.path,
      bytesWritten: progress.bytesWritten,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  private finish(status: RecordingStatus) {
    if (this.state.kind === "finished") return;
    this.state = { kind: "finished" };
    this.send("recording-status", { id: this.id, status });
    this.onFinished();
  }
}
