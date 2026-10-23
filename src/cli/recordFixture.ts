// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { decodeMulti, encode } from "@msgpack/msgpack";
import { createServer } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { WebSocketServer } from "ws";

export async function createNT4Fixture(options: { upgrade?: boolean; holdProbe?: boolean } = {}) {
  const sockets = new Set<Socket>();
  let acceptUpgrades = options.upgrade !== false;
  let notifyProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    notifyProbe = resolve;
  });
  let releaseProbe: () => void = () => {};
  const server = createServer((_, response) => {
    releaseProbe = () => response.end("NT4 fixture");
    notifyProbe();
    if (!options.holdProbe) releaseProbe();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const websocket = new WebSocketServer({
    noServer: true,
    handleProtocols: () => "networktables.first.wpi.edu"
  });
  server.on("upgrade", (request, socket, head) => {
    if (!acceptUpgrades) return;
    websocket.handleUpgrade(request, socket, head, (client) => websocket.emit("connection", client));
  });
  let upgrades = 0;
  websocket.on("connection", (client) => {
    upgrades++;
    let sent = false;
    client.on("message", (data, binary) => {
      if (binary) {
        for (const message of decodeMulti(data as Uint8Array)) {
          const frame = message as unknown[];
          if (frame[0] === -1) client.send(encode([-1, 1_000_000, 2, frame[3]]));
        }
        return;
      }
      const messages = JSON.parse(data.toString()) as {
        method: string;
        params: { options?: { all?: boolean; topicsonly?: boolean } };
      }[];
      if (
        sent ||
        !messages.some(
          (message) =>
            message.method === "subscribe" && message.params.options?.all && !message.params.options?.topicsonly
        )
      )
        return;
      sent = true;
      const topics = [
        { name: "/voltage", type: "double", properties: { unit: "V" } },
        { name: "/enabled", type: "boolean", properties: {} },
        { name: "/label", type: "string", properties: {} },
        { name: "/values", type: "double[]", properties: {} },
        { name: "/.schema/struct:Position", type: "structschema", properties: {} },
        { name: "/position", type: "struct:Position", properties: {} },
        { name: "/raw", type: "raw", properties: {} }
      ];
      client.send(JSON.stringify(topics.map((topic, id) => ({ method: "announce", params: { ...topic, id } }))));
      const position = new Uint8Array(8);
      new DataView(position.buffer).setFloat64(0, 3.25, true);
      const frames = [
        [0, 12_345_678, 1, 12.5],
        [0, 12_345_678, 1, 12.5],
        [1, 12_345_679, 0, true],
        [2, 12_345_680, 4, "ready λ"],
        [3, 12_345_681, 17, [1.5, -2]],
        [4, 12_345_682, 5, new TextEncoder().encode("double x;")],
        [5, 12_345_683, 5, position],
        [6, 12_345_684, 5, new Uint8Array([0, 255, 4])]
      ];
      frames.forEach((frame) => client.send(encode(frame)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    address: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    get upgrades() {
      return upgrades;
    },
    probeStarted,
    releaseProbe: () => releaseProbe(),
    disconnect() {
      acceptUpgrades = false;
      for (const client of websocket.clients) client.terminate();
    },
    async close() {
      for (const client of websocket.clients) client.terminate();
      sockets.forEach((socket) => socket.destroy());
      await Promise.all([
        new Promise<void>((resolve) => websocket.close(() => resolve())),
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      ]);
    }
  };
}
