// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import net from "net";
import { LiveFrameTransport } from "../../shared/live/LiveFrameTransport";

export class RlogTcpTransport implements LiveFrameTransport<Uint8Array> {
  private socket: net.Socket | null = null;
  private buffer = new Uint8Array();
  private dataTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private host: string,
    private port: number,
    private connectTimeoutMs: number,
    private dataTimeoutMs: number
  ) {}

  start(onFrame: (frame: Uint8Array) => boolean, onClose: () => void) {
    this.stop();
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    const close = () => {
      if (this.socket !== socket) return;
      this.stop();
      onClose();
    };
    socket.setTimeout(this.connectTimeoutMs, close);
    socket.on("error", close);
    socket.on("close", close);
    socket.on("data", (data) => {
      if (this.socket !== socket) return;
      const buffer = new Uint8Array(this.buffer.length + data.length);
      buffer.set(this.buffer);
      buffer.set(data, this.buffer.length);
      this.buffer = buffer;
      if (this.dataTimeout !== null) clearTimeout(this.dataTimeout);
      this.dataTimeout = setTimeout(close, this.dataTimeoutMs);

      while (this.socket === socket && this.buffer.length >= 4) {
        const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, 4).getInt32(0);
        if (length < 0) {
          close();
          return;
        }
        if (this.buffer.length < length + 4) return;
        const frame = this.buffer.slice(4, length + 4);
        this.buffer = this.buffer.slice(length + 4);
        if (length > 0 && !onFrame(frame)) {
          close();
          return;
        }
      }
    });
  }

  stop() {
    const socket = this.socket;
    this.socket = null;
    if (this.dataTimeout !== null) clearTimeout(this.dataTimeout);
    this.dataTimeout = null;
    this.buffer = new Uint8Array();
    socket?.destroy();
  }

  write(data: Uint8Array) {
    this.socket?.write(data);
  }
}
