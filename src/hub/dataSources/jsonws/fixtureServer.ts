// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { WebSocketServer } from "ws";
import { JSON_WEBSOCKET_PORT } from "./WebSocketTextTransport";

/** Local raw WebSocket server. Each text message is one JSON object. */
export function startFixtureServer(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const wss = new WebSocketServer({ port });
  wss.on("connection", (socket) => {
    let timestamp = 1;
    const sendSample = () => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ timestamp, BatteryVoltage: 12.4, pose: { x: 1.5, y: 2.5 } }));
      timestamp++;
    };
    sendSample();
    const timer = setInterval(sendSample, 500);
    timers.add(timer);
    socket.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  return new Promise((resolve, reject) => {
    wss.once("listening", () => {
      const address = wss.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise((done) => {
            for (const timer of timers) clearInterval(timer);
            timers.clear();
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          })
      });
    });
    wss.once("error", reject);
  });
}

if (require.main === module) {
  startFixtureServer(JSON_WEBSOCKET_PORT).then((server) => {
    console.log("json websocket fixture listening on " + server.port.toString());
  });
}
