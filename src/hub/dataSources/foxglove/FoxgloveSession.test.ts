// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import { getLiveModeName } from "../../../shared/Preferences";
import { startFixtureServer } from "./fixtureServer";
import { encodeMessageData, FOXGLOVE_SUBPROTOCOL, FoxgloveSession, foxgloveWebSocketUrl } from "./FoxgloveSession";

declare global {
  interface Window {
    preferences?: { timestamps: string };
    selection: {
      getTimelineRange(): [number, number];
      getTimelineIsMaxZoom(): boolean;
      setTimelineRange(range: [number, number], isMaxZoom: boolean): void;
    };
  }
}

const channels = [
  { id: 1, topic: "BatteryVoltage", encoding: "json", schemaName: "number", schema: "" },
  { id: 2, topic: "pose", encoding: "json", schemaName: "json", schema: "" },
  { id: 3, topic: "Scene", encoding: "protobuf", schemaName: "foxglove.SceneUpdate", schema: "" }
];

function serverInfo(): string {
  return JSON.stringify({
    op: "serverInfo",
    name: "test",
    capabilities: [],
    supportedEncodings: ["json"],
    metadata: {}
  });
}

function advertise(): string {
  return JSON.stringify({ op: "advertise", channels });
}

test("address uses the typed host and default port", () => {
  assert.equal(foxgloveWebSocketUrl("10.0.0.2"), "ws://10.0.0.2:8765");
  assert.equal(foxgloveWebSocketUrl("10.0.0.2:9000"), "ws://10.0.0.2:9000");
  assert.equal(foxgloveWebSocketUrl("ws://bridge.local/foxglove"), "ws://bridge.local/foxglove");
  assert.equal(foxgloveWebSocketUrl("wss://bridge.local:443"), "wss://bridge.local:443");
});

test("subscribe is sent after serverInfo for each advertised channel", () => {
  const sent: string[] = [];
  const session = new FoxgloveSession(
    (text) => sent.push(text),
    new Log(),
    () => {}
  );
  session.handleText(advertise());
  assert.equal(sent.length, 0);
  session.handleText(serverInfo());
  assert.equal(sent.length, 1);
  const message = JSON.parse(sent[0]);
  assert.equal(message.op, "subscribe");
  assert.deepEqual(
    message.subscriptions.map((subscription: { channelId: number }) => subscription.channelId),
    [1, 2, 3]
  );
  const ids = message.subscriptions.map((subscription: { id: number }) => subscription.id);
  assert.equal(new Set(ids).size, ids.length);

  session.handleText(advertise());
  assert.equal(sent.length, 1);
});

test("JSON samples become log fields and other encodings stay raw", () => {
  const sent: string[] = [];
  const log = new Log();
  const session = new FoxgloveSession(
    (text) => sent.push(text),
    log,
    () => {}
  );
  session.handleText(serverInfo());
  session.handleText(advertise());
  const subscriptions: { id: number; channelId: number }[] = JSON.parse(sent[0]).subscriptions;
  const idFor = (channelId: number) => subscriptions.find((subscription) => subscription.channelId === channelId)!.id;
  const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  session.handleBinary(encodeMessageData(idFor(1), 1000000000n, text(12.4)));
  session.handleBinary(encodeMessageData(idFor(2), 2000000000n, text({ x: 1.5, y: 2.5 })));
  session.handleBinary(encodeMessageData(idFor(3), 3000000000n, new Uint8Array([9, 8, 7])));
  session.handleBinary(new Uint8Array([2, 0, 0, 0, 0]));

  assert.equal(log.getType("BatteryVoltage"), LoggableType.Number);
  assert.equal(log.getNumber("BatteryVoltage", 0, 10)?.values[0], 12.4);
  assert.equal(log.getNumber("pose/x", 0, 10)?.values[0], 1.5);
  assert.equal(log.getNumber("pose/y", 0, 10)?.values[0], 2.5);
  assert.equal(log.getStructuredType("pose"), "JSON");
  assert.equal(log.getType("Scene"), LoggableType.Raw);
  assert.equal(log.getStructuredType("Scene"), "foxglove.SceneUpdate");
  assert.deepEqual(Array.from(log.getRaw("Scene", 0, 10)!.values[0]), [9, 8, 7]);
});

test("existing live modes keep their names", () => {
  assert.equal(getLiveModeName("nt4"), "NetworkTables");
  assert.equal(getLiveModeName("rlog"), "RLOG Server");
  assert.equal(getLiveModeName("phoenix"), "Phoenix Diagnostics");
  assert.equal(getLiveModeName("ftcdashboard"), "FTC Dashboard");
  assert.equal(getLiveModeName("foxglove"), "Foxglove WebSocket");
});

test("fixture server delivers a JSON sample", { timeout: 5000 }, async () => {
  const server = await startFixtureServer(0);
  const log = new Log();
  const socket = new WebSocket("ws://127.0.0.1:" + server.port.toString(), FOXGLOVE_SUBPROTOCOL);
  const session = new FoxgloveSession(
    (text) => socket.send(text),
    log,
    () => {}
  );
  socket.on("message", (data, isBinary) => {
    if (isBinary) session.handleBinary(new Uint8Array(data as Buffer));
    else session.handleText(data.toString());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture sample did not arrive")), 4000);
      const check = setInterval(() => {
        const voltage = log.getNumber("BatteryVoltage", 0, 100);
        const pose = log.getNumber("pose/x", 0, 100);
        const scene = log.getRaw("Scene", 0, 100);
        if (
          voltage !== undefined &&
          pose !== undefined &&
          scene !== undefined &&
          log.getStructuredType("Scene") === "foxglove.SceneUpdate"
        ) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 50);
    });
    assert.equal(log.getNumber("BatteryVoltage", 0, 100)?.values[0], 12.4);
    assert.equal(log.getNumber("pose/y", 0, 100)?.values[0], 2.5);
  } finally {
    socket.close();
    await server.close();
  }
});
