// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { Worker } from "node:worker_threads";
import { LogMetadata } from "../../../shared/LogManager";

interface MetadataRequest {
  id: number;
  path: string;
  resolve: (metadata: LogMetadata) => void;
  reject: (error: Error) => void;
}

export class MetadataClient {
  private worker: Worker | undefined;
  private queue: MetadataRequest[] = [];
  private active: MetadataRequest | undefined;
  private timer: NodeJS.Timeout | undefined;
  private nextId = 0;
  private closed = false;

  constructor(private workerPath: string) {}

  extract(path: string): Promise<LogMetadata> {
    if (this.closed) return Promise.reject(new Error("The log metadata worker is closed."));
    if (this.queue.length >= 256) return Promise.reject(new Error("The metadata queue is full. Refresh to retry."));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, path, resolve, reject });
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error("The log metadata worker is closed.");
    this.active?.reject(error);
    this.active = undefined;
    for (const request of this.queue) request.reject(error);
    this.queue = [];
    clearTimeout(this.timer);
    void this.worker?.terminate();
    this.worker = undefined;
  }

  private createWorker(): Worker {
    const worker = new Worker(this.workerPath);
    worker.on("message", (response: { id: number; metadata: LogMetadata }) => {
      if (this.worker !== worker || response.id !== this.active?.id) return;
      clearTimeout(this.timer);
      const request = this.active;
      this.active = undefined;
      request.resolve(response.metadata);
      this.pump();
    });
    worker.on("error", (error) => this.fail(worker, error));
    worker.on("exit", (code) => this.fail(worker, new Error(`Metadata worker exited with code ${code}.`)));
    return worker;
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const request = this.queue.shift();
    if (!request) return;
    this.active = request;
    try {
      const worker = (this.worker ??= this.createWorker());
      this.timer = setTimeout(() => {
        this.fail(worker, new Error("Reading log metadata timed out."));
        void worker.terminate();
      }, 15000);
      worker.postMessage({ id: request.id, path: request.path });
    } catch (error) {
      this.active = undefined;
      request.reject(error instanceof Error ? error : new Error(String(error)));
      this.pump();
    }
  }

  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    clearTimeout(this.timer);
    this.active?.reject(error);
    this.active = undefined;
    this.pump();
  }
}
