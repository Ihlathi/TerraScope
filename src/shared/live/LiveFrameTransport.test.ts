// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import net from "node:net";
import { test, TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { startFixtureServer } from "../../hub/dataSources/foxglove/fixtureServer";
import { FOXGLOVE_SUBPROTOCOL, FoxgloveSession } from "../../hub/dataSources/foxglove/FoxgloveSession";
import RLOGDecoder from "../../hub/dataSources/rlog/RLOGDecoder";
import { RlogTcpTransport } from "../../main/electron/RlogTcpTransport";
import Log from "../log/Log";
import { WebSocketFrameTransport } from "./WebSocketFrameTransport";

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Expected transport event did not arrive");
    await delay(10);
  }
}

async function tcpServer(t: TestContext) {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as net.AddressInfo;
  return { sockets, port: address.port };
}

function prefixed(payload: number[] | Uint8Array) {
  const result = new Uint8Array(4 + payload.length);
  new DataView(result.buffer).setInt32(0, payload.length);
  result.set(payload, 4);
  return result;
}

test("TCP delivers opaque frames across split headers, bodies, heartbeats and coalesced packets", async (t) => {
  const server = await tcpServer(t);
  const transport = new RlogTcpTransport("127.0.0.1", server.port, 2000, 2000);
  t.after(() => transport.stop());
  const received: Uint8Array[] = [];
  transport.start((frame) => {
    received.push(frame);
    return true;
  }, assert.fail);
  await waitFor(() => server.sockets.length === 1);
  const socket = server.sockets[0];
  const first = prefixed([255, 0, 128]);
  socket.write(first.subarray(0, 2));
  await delay(20);
  assert.deepEqual(received, []);
  socket.write(first.subarray(2, 5));
  await delay(20);
  assert.deepEqual(received, []);
  const last = prefixed([7, 8]);
  socket.write(Buffer.concat([first.subarray(5), prefixed([]), prefixed([42]), last.subarray(0, 5)]));
  await waitFor(() => received.length === 2);
  assert.deepEqual(
    received.map((frame) => Array.from(frame)),
    [[255, 0, 128], [42]]
  );
  socket.write(last.subarray(5));
  await waitFor(() => received.length === 3);
  assert.deepEqual(Array.from(received[2]), [7, 8]);
});

test("TCP payloads decode with the unchanged RLOG decoder and writes reach the peer", async (t) => {
  const server = await tcpServer(t);
  const transport = new RlogTcpTransport("127.0.0.1", server.port, 2000, 2000);
  t.after(() => transport.stop());
  const log = new Log();
  const decoder = new RLOGDecoder(false);
  let decoded = false;
  transport.start((frame) => {
    decoded = decoder.decode(log, frame);
    return decoded;
  }, assert.fail);
  await waitFor(() => server.sockets.length === 1);
  const key = Buffer.from("BatteryVoltage");
  const payload = Buffer.alloc(1 + 1 + 8 + 1 + 2 + 2 + key.length + 1 + 2 + 1 + 8);
  payload[0] = 1;
  payload.writeDoubleBE(1.5, 2);
  payload[10] = 1;
  payload.writeInt16BE(1, 11);
  payload.writeInt16BE(key.length, 13);
  key.copy(payload, 15);
  const update = 15 + key.length;
  payload[update] = 2;
  payload.writeInt16BE(1, update + 1);
  payload[update + 3] = 5;
  payload.writeDoubleBE(12.4, update + 4);
  server.sockets[0].write(prefixed(payload));
  await waitFor(() => decoded);
  assert.deepEqual(log.getNumber("BatteryVoltage", 0, 10), { timestamps: [1.5], values: [12.4] });
  const outbound: Buffer[] = [];
  server.sockets[0].on("data", (data) => outbound.push(data));
  transport.write(new Uint8Array([6, 3, 2, 8]));
  await waitFor(() => outbound.length > 0);
  assert.deepEqual(Array.from(Buffer.concat(outbound)), [6, 3, 2, 8]);
});

test("TCP stop and restart discard partial frames and suppress the old connection's close", async (t) => {
  const server = await tcpServer(t);
  const transport = new RlogTcpTransport("127.0.0.1", server.port, 2000, 2000);
  t.after(() => transport.stop());
  let oldFrames = 0;
  let closes = 0;
  transport.start(
    () => {
      oldFrames++;
      return true;
    },
    () => closes++
  );
  await waitFor(() => server.sockets.length === 1);
  server.sockets[0].write(prefixed([9, 9]).subarray(0, 5));
  await delay(20);
  transport.stop();
  transport.stop();
  const frames: Uint8Array[] = [];
  transport.start(
    (frame) => {
      frames.push(frame);
      return true;
    },
    () => closes++
  );
  await waitFor(() => server.sockets.length === 2);
  server.sockets[1].write(prefixed([3]));
  await waitFor(() => frames.length === 1);
  assert.equal(oldFrames, 0);
  assert.equal(closes, 0);
  assert.deepEqual(Array.from(frames[0]), [3]);
});

test("TCP frame rejection stops delivery of the rest of a packet", async (t) => {
  const server = await tcpServer(t);
  const transport = new RlogTcpTransport("127.0.0.1", server.port, 2000, 2000);
  t.after(() => transport.stop());
  const frames: Uint8Array[] = [];
  let closes = 0;
  transport.start(
    (frame) => {
      frames.push(frame);
      return false;
    },
    () => closes++
  );
  await waitFor(() => server.sockets.length === 1);
  server.sockets[0].write(Buffer.concat([prefixed([1]), prefixed([2])]));
  await waitFor(() => closes === 1);
  assert.equal(frames.length, 1);
  assert.deepEqual(Array.from(frames[0]), [1]);
});

test("TCP data timeout disconnects even while outbound heartbeats keep the socket busy", async (t) => {
  const server = await tcpServer(t);
  const transport = new RlogTcpTransport("127.0.0.1", server.port, 1000, 100);
  t.after(() => transport.stop());
  let frames = 0;
  let closes = 0;
  let writes = 0;
  transport.start(
    () => {
      frames++;
      return true;
    },
    () => closes++
  );
  await waitFor(() => server.sockets.length === 1);
  server.sockets[0].on("data", () => writes++);
  server.sockets[0].write(prefixed([1]));
  await waitFor(() => frames === 1);
  const heartbeat = setInterval(() => transport.write(new Uint8Array([6, 3, 2, 8])), 10);
  t.after(() => clearInterval(heartbeat));
  await waitFor(() => closes === 1);
  clearInterval(heartbeat);
  await delay(20);
  assert.equal(closes, 1);
  assert.ok(writes > 0);
});

test("TCP rejects a negative length without hanging or delivering bytes", async (t) => {
  const server = await tcpServer(t);
  const transport = new RlogTcpTransport("127.0.0.1", server.port, 2000, 2000);
  t.after(() => transport.stop());
  let frames = 0;
  let closes = 0;
  transport.start(
    () => {
      frames++;
      return true;
    },
    () => closes++
  );
  await waitFor(() => server.sockets.length === 1);
  server.sockets[0].write(new Uint8Array([255, 255, 255, 255]));
  await waitFor(() => closes === 1);
  assert.equal(frames, 0);
});

test("TCP connection errors notify once despite the following close event", async (t) => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const transport = new RlogTcpTransport("127.0.0.1", port, 2000, 2000);
  t.after(() => transport.stop());
  let closes = 0;
  transport.start(
    () => assert.fail("No peer can deliver a frame"),
    () => closes++
  );
  await waitFor(() => closes === 1);
  await delay(20);
  assert.equal(closes, 1);
});

test("WebSocket preserves text, binary, subprotocol and outbound writes", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const transport = new WebSocketFrameTransport(
    `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    "test.frames"
  );
  t.after(() => transport.stop());
  const received: (string | Uint8Array)[] = [];
  const outbound: { value: string; binary: boolean }[] = [];
  server.on("connection", (socket) => {
    assert.equal(socket.protocol, "test.frames");
    socket.on("message", (data, binary) => outbound.push({ value: data.toString(), binary }));
    socket.send("not JSON");
    socket.send(new Uint8Array([0, 255, 128]));
  });
  transport.start((frame) => {
    received.push(frame);
    return true;
  }, assert.fail);
  await waitFor(() => received.length === 2);
  assert.equal(received[0], "not JSON");
  assert.deepEqual(Array.from(received[1] as Uint8Array), [0, 255, 128]);
  transport.write("subscribe");
  transport.write(new TextEncoder().encode("binary"));
  await waitFor(() => outbound.length === 2);
  assert.deepEqual(outbound, [
    { value: "subscribe", binary: false },
    { value: "binary", binary: true }
  ]);
});

test("WebSocket restart suppresses old callbacks and a rejected frame closes once", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const sockets: import("ws").WebSocket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  const transport = new WebSocketFrameTransport(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
  t.after(() => transport.stop());
  let oldFrames = 0;
  let closes = 0;
  transport.start(
    () => {
      oldFrames++;
      return true;
    },
    () => closes++
  );
  await waitFor(() => sockets.length === 1);
  transport.stop();
  transport.stop();
  const frames: (string | Uint8Array)[] = [];
  transport.start(
    (frame) => {
      frames.push(frame);
      return false;
    },
    () => closes++
  );
  await waitFor(() => sockets.length === 2);
  sockets[1].send("first");
  sockets[1].send("second");
  await waitFor(() => closes === 1);
  assert.equal(oldFrames, 0);
  assert.deepEqual(frames, ["first"]);
  assert.equal(closes, 1);
});

test("Foxglove session decodes negotiated telemetry through the frame transport", async (t) => {
  const server = await startFixtureServer(0);
  t.after(() => server.close());
  const transport = new WebSocketFrameTransport(`ws://127.0.0.1:${server.port}`, FOXGLOVE_SUBPROTOCOL);
  t.after(() => transport.stop());
  const log = new Log();
  const session = new FoxgloveSession(
    (text) => transport.write(text),
    log,
    () => {}
  );
  transport.start((frame) => {
    if (typeof frame === "string") session.handleText(frame);
    else session.handleBinary(frame);
    return true;
  }, assert.fail);
  await waitFor(() => log.getRaw("Scene", 0, 100) !== undefined);
  assert.equal(log.getNumber("BatteryVoltage", 0, 100)?.values[0], 12.4);
  assert.equal(log.getNumber("pose/x", 0, 100)?.values[0], 1.5);
  assert.equal(log.getNumber("pose/y", 0, 100)?.values[0], 2.5);
  assert.equal(log.getStructuredType("Scene"), "foxglove.SceneUpdate");
  assert.deepEqual(Array.from(log.getRaw("Scene", 0, 100)!.values[0]), [1, 2, 3]);
});
