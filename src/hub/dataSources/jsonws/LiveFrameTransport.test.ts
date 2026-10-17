// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { RlogTcpTransport } from "../../../main/electron/RlogTcpTransport";
import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import { getLiveModeName } from "../../../shared/Preferences";
import { readLengthPrefixedFrames } from "../rlog/readLengthPrefixedFrames";
import { startFixtureServer } from "./fixtureServer";
import { JsonFrameDecoder } from "./JsonFrameDecoder";
import { textMessageFrame } from "./textMessageFrame";
import { jsonWebSocketUrl, WebSocketTextTransport } from "./WebSocketTextTransport";

declare global {
  interface Window {
    preferences?: { timestamps: string };
    selection: {
      getTimelineRange(): [number, number];
    };
  }
}

function lengthPrefixed(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setInt32(0, payload.length);
  frame.set(payload, 4);
  return frame;
}

test("length-prefixed stream yields complete payloads only", () => {
  const first = lengthPrefixed(new Uint8Array([1, 2, 3]));
  const second = lengthPrefixed(new Uint8Array([4]));
  const empty = lengthPrefixed(new Uint8Array());
  const combined = new Uint8Array(first.length + second.length + empty.length);
  combined.set(first);
  combined.set(second, first.length);
  combined.set(empty, first.length + second.length);

  const partial = readLengthPrefixedFrames(combined.slice(0, 2));
  assert.equal(partial.frames.length, 0);
  assert.equal(partial.rest.length, 2);

  const split = readLengthPrefixedFrames(combined);
  assert.equal(split.frames.length, 2);
  assert.deepEqual(Array.from(split.frames[0]), [1, 2, 3]);
  assert.deepEqual(Array.from(split.frames[1]), [4]);
  assert.equal(split.rest.length, 0);
});

test("RLOG TCP transport delivers a framed payload", async () => {
  const server = net.createServer((socket) => {
    const payload = new TextEncoder().encode("rlog-frame");
    const frame = lengthPrefixed(payload);
    socket.write(frame.slice(0, 3));
    setTimeout(() => socket.write(frame.slice(3)), 20);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const frames: Uint8Array[] = [];
  const transport = new RlogTcpTransport("127.0.0.1", port, 3000, 3000, () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("rlog frame did not arrive")), 2000);
      transport.start(
        (frame) => {
          frames.push(frame);
          clearTimeout(timer);
          resolve();
          return true;
        },
        () => {}
      );
    });
    assert.equal(new TextDecoder().decode(frames[0]), "rlog-frame");
  } finally {
    transport.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("one text message decodes into log fields", () => {
  const frame = textMessageFrame(JSON.stringify({ timestamp: 1.5, BatteryVoltage: 12.4, pose: { x: 1.5, y: 2.5 } }));
  const log = new Log();
  const decoder = new JsonFrameDecoder();
  assert.equal(decoder.decode(log, frame), true);
  assert.equal(log.getType("BatteryVoltage"), LoggableType.Number);
  assert.equal(log.getNumber("BatteryVoltage", 0, 10)?.values[0], 12.4);
  assert.equal(log.getNumber("pose/x", 0, 10)?.values[0], 1.5);
  assert.equal(log.getNumber("pose/y", 0, 10)?.values[0], 2.5);
  assert.equal(log.getStructuredType("pose"), "JSON");
  assert.equal(decoder.latestTime, 1.5);
  assert.equal(decoder.decode(log, textMessageFrame("not-json")), false);
});

test("typed address keeps its port", () => {
  assert.equal(jsonWebSocketUrl("127.0.0.1"), "ws://127.0.0.1:8735");
  assert.equal(jsonWebSocketUrl("127.0.0.1:9000"), "ws://127.0.0.1:9000");
  assert.equal(jsonWebSocketUrl("wss://bridge.local/live"), "wss://bridge.local/live");
});

test("existing live modes keep their names", () => {
  assert.equal(getLiveModeName("nt4"), "NetworkTables");
  assert.equal(getLiveModeName("rlog"), "RLOG Server");
  assert.equal(getLiveModeName("phoenix"), "Phoenix Diagnostics");
  assert.equal(getLiveModeName("ftcdashboard"), "FTC Dashboard");
  assert.equal(getLiveModeName("jsonws"), "JSON WebSocket");
});

test("fixture text frames land on the log", { timeout: 5000 }, async () => {
  const server = await startFixtureServer(0);
  const log = new Log();
  const decoder = new JsonFrameDecoder();
  const transport = new WebSocketTextTransport("ws://127.0.0.1:" + server.port.toString());
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("json frame did not arrive")), 4000);
      transport.start(
        (frame) => {
          if (decoder.decode(log, frame) && log.getNumber("BatteryVoltage", 0, 100) !== undefined) {
            clearTimeout(timer);
            resolve();
          }
          return true;
        },
        () => {}
      );
    });
    assert.equal(log.getNumber("BatteryVoltage", 0, 100)?.values[0], 12.4);
    assert.equal(log.getNumber("pose/y", 0, 100)?.values[0], 2.5);
  } finally {
    transport.stop();
    await server.close();
  }
});
