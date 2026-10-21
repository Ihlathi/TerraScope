// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { RecordingSample, RecordingStatus, recordingSampleSize } from "../shared/recording/RecordingWriter";

interface RecordingSource {
  startRecording(listener: (sample: RecordingSample) => void): void;
  stopRecording(): void;
}

export interface RecordingControlState {
  kind: "idle" | "starting" | "recording" | "stopping" | "stopped" | "error";
  path: string;
  bytesWritten: number;
  message: string;
}

interface Session {
  id: number;
  phase: "starting" | "recording" | "stopping" | "closing";
  pending: { sample: RecordingSample; bytes: number }[];
  pendingBytes: number;
  inFlight: number | null;
  nextBatch: number;
  stopSent: boolean;
  message: string;
}

export default class LiveRecording {
  private session: Session | null = null;
  private stopped: (() => void)[] = [];
  private state: RecordingControlState = { kind: "idle", path: "", bytesWritten: 0, message: "" };

  constructor(
    private source: RecordingSource,
    private send: (name: string, data: unknown) => void,
    private onChange: (state: RecordingControlState) => void,
    private maxPendingBytes = 4 * 1024 * 1024,
    private nextId = Date.now() * 1024 + Math.floor(Math.random() * 1024)
  ) {}

  getState(): RecordingControlState {
    return { ...this.state };
  }

  start() {
    if (this.session !== null) return;
    this.session = {
      id: ++this.nextId,
      phase: "starting",
      pending: [],
      pendingBytes: 0,
      inFlight: null,
      nextBatch: 0,
      stopSent: false,
      message: ""
    };
    this.update({ kind: "starting", path: "", bytesWritten: 0, message: "Choose a recording file" });
    this.send("recording-start", { id: this.session.id });
  }

  stop(message = ""): Promise<void> {
    const session = this.session;
    if (session === null) return Promise.resolve();
    const completed = new Promise<void>((resolve) => this.stopped.push(resolve));
    if (session.phase === "closing") return completed;
    this.source.stopRecording();
    session.phase = "stopping";
    if (message) session.message = message;
    this.update({ ...this.state, kind: "stopping", message: message || "Finishing recording" });
    this.flush();
    return completed;
  }

  handleMessage(name: string, data: any): boolean {
    if (!name.startsWith("recording-")) return false;
    const session = this.session;
    if (session === null || data?.id !== session.id) return true;
    switch (name) {
      case "recording-ready":
        if (session.phase === "stopping") {
          this.flush();
          break;
        }
        session.phase = "recording";
        this.update({ kind: "recording", path: data.path, bytesWritten: 0, message: "Recording" });
        try {
          this.source.startRecording((sample) => this.accept(sample));
        } catch (error) {
          void this.stop(error instanceof Error ? error.message : String(error));
        }
        break;
      case "recording-ack":
        if (data.batch !== session.inFlight) break;
        session.inFlight = null;
        this.flush();
        break;
      case "recording-request-stop":
        void this.stop();
        break;
      case "recording-status": {
        const status: RecordingStatus = data.status;
        if (status.kind === "stopped" || status.kind === "error" || status.kind === "idle") {
          const failed = status.kind === "error" || (status.kind === "stopped" && status.reason === "low-disk");
          const message = "message" in status ? status.message : "";
          this.source.stopRecording();
          this.session = null;
          this.update({
            kind: status.kind,
            path: status.path,
            bytesWritten: status.bytesWritten,
            message:
              (failed ? message : session.message || message) || (status.kind === "stopped" ? "Recording saved" : "")
          });
          this.stopped.splice(0).forEach((resolve) => resolve());
        } else if (status.kind === "stopping") {
          this.source.stopRecording();
          session.phase = "closing";
          session.pending = [];
          session.pendingBytes = 0;
          this.update({
            ...this.state,
            kind: "stopping",
            bytesWritten: status.bytesWritten,
            message: "Finishing recording"
          });
        } else if (status.kind === "recording") {
          this.update({ ...this.state, bytesWritten: status.bytesWritten });
        }
        break;
      }
    }
    return true;
  }

  private accept(sample: RecordingSample) {
    const session = this.session;
    if (session === null || session.phase !== "recording") return;
    const bytes = recordingSampleSize(sample);
    if (session.pendingBytes + bytes > this.maxPendingBytes) {
      void this.stop("Recording stopped because storage could not keep up. Accepted samples were saved.");
      return;
    }
    session.pending.push({ sample, bytes });
    session.pendingBytes += bytes;
    this.flush();
  }

  private flush() {
    const session = this.session;
    if (session === null || session.phase === "closing" || session.inFlight !== null) return;
    if (session.pending.length > 0) {
      let bytes = 0;
      let count = 0;
      while (count < session.pending.length && (count === 0 || bytes < 256 * 1024)) {
        bytes += session.pending[count++].bytes;
      }
      const samples = session.pending.splice(0, count).map((item) => item.sample);
      session.pendingBytes -= bytes;
      session.inFlight = ++session.nextBatch;
      this.send("recording-batch", { id: session.id, batch: session.inFlight, samples });
    } else if (session.phase === "stopping" && !session.stopSent) {
      session.stopSent = true;
      this.send("recording-stop", { id: session.id, message: session.message });
    }
  }

  private update(state: RecordingControlState) {
    this.state = state;
    this.onChange(this.getState());
  }
}
