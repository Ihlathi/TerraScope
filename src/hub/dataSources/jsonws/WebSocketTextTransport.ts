// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { LiveFrameTransport } from "../../../shared/live/LiveFrameTransport";
import { textMessageFrame } from "./textMessageFrame";

export const JSON_WEBSOCKET_PORT = 8735;

/** Builds a WebSocket URL from a typed address. Schemes are kept; a bare host uses port 8735. */
export function jsonWebSocketUrl(address: string, defaultPort = JSON_WEBSOCKET_PORT): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    const host = trimmed.slice(0, colon);
    const hostIsIpv6 = host.includes(":");
    const hostIsBracketed = host.startsWith("[") && host.endsWith("]");
    if (!hostIsIpv6 || hostIsBracketed) {
      return "ws://" + trimmed;
    }
  }
  return "ws://" + trimmed + ":" + defaultPort.toString();
}

/** Raw WebSocket that delivers each text message as bytes. It does not decode JSON. */
export class WebSocketTextTransport implements LiveFrameTransport {
  private socket: WebSocket | null = null;

  constructor(private url: string) {}

  start(onFrame: (frame: Uint8Array) => boolean, onClose: () => void) {
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      if (!onFrame(textMessageFrame(event.data))) socket.close();
    };
    socket.onclose = () => {
      if (this.socket === socket) onClose();
    };
  }

  stop() {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
