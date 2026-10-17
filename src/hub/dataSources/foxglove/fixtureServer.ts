// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { WebSocketServer } from "ws";
import { encodeMessageData, FOXGLOVE_DEFAULT_PORT, FOXGLOVE_SUBPROTOCOL } from "./FoxgloveSession";

const textEncoder = new TextEncoder();

/** Local Foxglove ws-protocol server used by tests and the live screenshot. */
export function startFixtureServer(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const wss = new WebSocketServer({
    port,
    handleProtocols: (protocols) => (protocols.has(FOXGLOVE_SUBPROTOCOL) ? FOXGLOVE_SUBPROTOCOL : false)
  });

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        op: "serverInfo",
        name: "terrascope-fixture",
        capabilities: [],
        supportedEncodings: ["json"],
        metadata: {}
      })
    );
    socket.send(
      JSON.stringify({
        op: "advertise",
        channels: [
          { id: 1, topic: "BatteryVoltage", encoding: "json", schemaName: "number", schema: "" },
          { id: 2, topic: "pose", encoding: "json", schemaName: "json", schema: "" },
          { id: 3, topic: "Scene", encoding: "protobuf", schemaName: "foxglove.SceneUpdate", schema: "" }
        ]
      })
    );

    const subscriptions = new Map<number, number>();
    let sequence = 1;
    const sendSamples = () => {
      if (socket.readyState !== socket.OPEN) return;
      const timestampNs = BigInt(sequence) * 1000000000n;
      sequence++;
      for (const [subscriptionId, channelId] of subscriptions) {
        let payload: Uint8Array;
        if (channelId === 1) payload = textEncoder.encode(JSON.stringify(12.4));
        else if (channelId === 2) payload = textEncoder.encode(JSON.stringify({ x: 1.5, y: 2.5 }));
        else payload = new Uint8Array([1, 2, 3]);
        socket.send(encodeMessageData(subscriptionId, timestampNs, payload));
      }
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message === null || message.op !== "subscribe" || !Array.isArray(message.subscriptions)) return;
      for (const subscription of message.subscriptions) {
        if (typeof subscription?.id === "number" && typeof subscription.channelId === "number") {
          subscriptions.set(subscription.id, subscription.channelId);
        }
      }
      sendSamples();
    });

    const timer = setInterval(sendSamples, 500);
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
  startFixtureServer(FOXGLOVE_DEFAULT_PORT).then((server) => {
    console.log("foxglove fixture listening on " + server.port.toString());
  });
}
