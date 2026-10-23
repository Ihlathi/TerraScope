// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import test from "node:test";
import BrowserWebSocket, { WebSocketServer } from "ws";
import { NT4_Client } from "./NT4";

for (const [runtime, WebSocketImplementation] of [
  ["native", globalThis.WebSocket],
  ["browser-compatible", BrowserWebSocket]
] as const) {
  test(`${runtime} NT4 disconnect hook can stop both main and RTT sockets once`, { timeout: 5000 }, async (t) => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = WebSocketImplementation as typeof globalThis.WebSocket;
    t.after(() => {
      globalThis.WebSocket = original;
    });
    const server = createServer((_, response) => response.end("NT4"));
    const websocket = new WebSocketServer({ server });
    let primary: BrowserWebSocket | undefined;
    let closed = 0;
    let finishClosing!: () => void;
    const socketsClosed = new Promise<void>((resolve) => {
      finishClosing = resolve;
    });
    let receivedRTT!: () => void;
    const rttReady = new Promise<void>((resolve) => {
      receivedRTT = resolve;
    });
    websocket.on("connection", (socket) => {
      if (socket.protocol === "rtt.networktables.first.wpi.edu") socket.once("message", receivedRTT);
      else primary = socket;
      socket.once("close", () => {
        if (++closed === 2) finishClosing();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let connected = 0;
    let disconnected = 0;
    const client = new NT4_Client(
      "127.0.0.1",
      [(server.address() as AddressInfo).port],
      "lifecycle-test",
      () => {},
      () => {},
      () => {},
      () => {},
      () => {
        connected++;
      },
      () => {
        disconnected++;
        client.disconnect();
      }
    );
    t.after(async () => {
      client.disconnect();
      for (const socket of websocket.clients) socket.terminate();
      server.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => websocket.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve()))
      ]);
    });
    client.connect();
    await rttReady;
    assert.equal(connected, 1);
    primary!.close();
    await socketsClosed;
    client.disconnect();
    assert.equal(disconnected, 1);
    assert.equal(connected, 1);
    assert.equal(websocket.clients.size, 0);
  });
}
