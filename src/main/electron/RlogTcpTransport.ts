// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import net from "net";
import { readLengthPrefixedFrames } from "../../hub/dataSources/rlog/readLengthPrefixedFrames";
import { LiveFrameTransport } from "../../shared/live/LiveFrameTransport";

/** RLOG TCP socket. Frames length-prefixed bytes and leaves decoding to RLOGDecoder. */
export class RlogTcpTransport implements LiveFrameTransport {
  private socket: net.Socket | null = null;
  private buffer = new Uint8Array();
  private dataTimeout: NodeJS.Timeout | null = null;

  constructor(
    private host: string,
    private port: number,
    private connectTimeoutMs: number,
    private dataTimeoutMs: number,
    private onConnectTimeout: () => void
  ) {}

  start(onFrame: (frame: Uint8Array) => boolean, onClose: () => void) {
    this.socket?.destroy();
    this.buffer = new Uint8Array();
    this.socket = net.createConnection({
      host: this.host,
      port: this.port
    });
    this.socket.setTimeout(this.connectTimeoutMs, () => {
      this.onConnectTimeout();
    });
    this.socket.on("data", (data) => {
      this.append(data);
      if (this.dataTimeout !== null) clearTimeout(this.dataTimeout);
      this.dataTimeout = setTimeout(() => {
        this.socket?.destroy();
      }, this.dataTimeoutMs);
      const split = readLengthPrefixedFrames(this.buffer);
      this.buffer = split.rest;
      for (const frame of split.frames) {
        if (!onFrame(frame)) this.socket?.destroy();
      }
    });
    this.socket.on("error", () => {
      onClose();
    });
    this.socket.on("close", () => {
      onClose();
    });
  }

  stop() {
    this.socket?.destroy();
  }

  write(data: Uint8Array) {
    this.socket?.write(data);
  }

  private append(chunk: Uint8Array) {
    const full = new Uint8Array(this.buffer.length + chunk.length);
    full.set(this.buffer);
    full.set(chunk, this.buffer.length);
    this.buffer = full;
  }
}
