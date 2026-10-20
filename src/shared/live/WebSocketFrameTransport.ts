// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { LiveFrameTransport } from "./LiveFrameTransport";

export class WebSocketFrameTransport implements LiveFrameTransport<string | Uint8Array> {
  private socket: WebSocket | null = null;

  constructor(
    private url: string,
    private protocols?: string | string[]
  ) {}

  start(onFrame: (frame: string | Uint8Array) => boolean, onClose: () => void) {
    this.stop();
    const socket = new WebSocket(this.url, this.protocols);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const close = () => {
      if (this.socket !== socket) return;
      this.stop();
      onClose();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let frame: string | Uint8Array;
      if (typeof event.data === "string") frame = event.data;
      else if (event.data instanceof ArrayBuffer) frame = new Uint8Array(event.data);
      else return;
      if (!onFrame(frame)) close();
    };
    socket.onclose = close;
  }

  stop() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  write(data: string | Uint8Array) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(data);
  }
}
