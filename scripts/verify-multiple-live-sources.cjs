// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { decodeMulti, encode } = require("@msgpack/msgpack");
const { WebSocket, WebSocketServer } = require("ws");

async function startNT4Fixture(host, clockStart, phase) {
  const started = performance.now();
  const serverTime = () => clockStart + (performance.now() - started) / 1000;
  const server = http.createServer((_, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("TerraScope local fixture");
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols: (protocols) =>
      protocols.has("networktables.first.wpi.edu") ? "networktables.first.wpi.edu" : false
  });
  const timers = new Set();
  const subscriptions = [];
  sockets.on("connection", (socket) => {
    const active = new Map();
    socket.send(
      JSON.stringify([
        {
          method: "announce",
          params: { id: 1, name: "/BatteryVoltage", type: "double", properties: { unit: "V", mutable: false } }
        }
      ])
    );
    const sendSample = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const selected = [...active.values()].some(
        (subscription) =>
          !subscription.options.topicsonly &&
          subscription.topics.some((topic) =>
            subscription.options.prefix ? "/BatteryVoltage".startsWith(topic) : topic === "/BatteryVoltage"
          )
      );
      if (selected) {
        const seconds = serverTime();
        socket.send(encode([1, Math.round(seconds * 1e6), 1, 12 + 0.7 * Math.sin(seconds * 1.6 + phase)]));
      }
    };
    socket.on("message", (bytes, binary) => {
      if (binary) {
        for (const message of decodeMulti(bytes)) {
          if (message[0] === -1) socket.send(encode([-1, Math.round(serverTime() * 1e6), 2, message[3]]));
        }
      } else {
        for (const message of JSON.parse(bytes.toString())) {
          if (message.method === "subscribe") {
            active.set(message.params.subuid, message.params);
            subscriptions.push(message.params);
          } else if (message.method === "unsubscribe") {
            active.delete(message.params.subuid);
          }
        }
        sendSample();
      }
    });
    const timer = setInterval(sendSample, 50);
    timers.add(timer);
    socket.once("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(5810, host, resolve);
  });
  return {
    subscriptions,
    clientCount: () => sockets.clients.size,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function startFoxgloveFixture() {
  const started = performance.now();
  const sockets = new WebSocketServer({
    port: 8765,
    host: "127.0.0.1",
    handleProtocols: (protocols) => (protocols.has("foxglove.websocket.v1") ? "foxglove.websocket.v1" : false)
  });
  const timers = new Set();
  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ op: "serverInfo", name: "TerraScope local fixture", capabilities: [] }));
    socket.send(
      JSON.stringify({
        op: "advertise",
        channels: [{ id: 1, topic: "/BatteryVoltage", encoding: "json", schemaName: "number", schema: "" }]
      })
    );
    const subscriptions = new Set();
    const sendSample = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const seconds = 3600 + (performance.now() - started) / 1000;
      const payload = Buffer.from(JSON.stringify(12 + 0.7 * Math.cos(seconds * 1.6)));
      for (const id of subscriptions) {
        const data = Buffer.alloc(13 + payload.length);
        data.writeUInt8(1, 0);
        data.writeUInt32LE(id, 1);
        data.writeBigUInt64LE(BigInt(Math.round(seconds * 1e9)), 5);
        payload.copy(data, 13);
        socket.send(data);
      }
    };
    socket.on("message", (bytes, binary) => {
      if (binary) return;
      const message = JSON.parse(bytes.toString());
      if (message.op === "subscribe") {
        for (const subscription of message.subscriptions) subscriptions.add(subscription.id);
        sendSample();
      }
    });
    const timer = setInterval(sendSample, 50);
    timers.add(timer);
    socket.once("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  await new Promise((resolve, reject) => {
    sockets.once("listening", resolve);
    sockets.once("error", reject);
  });
  return {
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
    }
  };
}

async function connectDebugger(port) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((item) => item.url.endsWith("/hub.html"));
  assert(page, "The running Electron app has a hub page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Debugger request timed out for ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    call,
    evaluate: async (expression) => {
      const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    },
    close: () => socket.close()
  };
}

async function until(read, accepts, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accepts(value)) return value;
    await delay(100);
  }
  assert.fail(`${message}. Last value was ${JSON.stringify(value)}`);
}

async function configureGraph(debuggerClient, keys) {
  return debuggerClient.evaluate(`(() => {
    const keys = ${JSON.stringify(keys)};
    let state = window.tabs.saveState();
    if (!state.tabs.some(tab => tab.type === 1)) {
      window.tabs.addTab(1);
      state = window.tabs.saveState();
    }
    const graph = state.tabs.find(tab => tab.type === 1);
    graph.title = "Two live sources";
    graph.controlsHeight = 180;
    graph.controller = {
      ...graph.controller,
      leftSources: keys.map((logKey, index) => ({
        type: "smooth", logKey, logType: "Number", visible: true,
        options: {color: index === 0 ? "#2b66a2" : "#e5b31b", size: "bold"}
      })),
      rightSources: [], discreteSources: [], showRobotMode: false,
      leftLockedRange: [10.8, 13.2]
    };
    window.tabs.restoreState({selected: 0, tabs: [graph]});
    const expanded = new Set();
    for (const key of keys) {
      const parts = key.split(/\\/|:/).filter(Boolean);
      for (let end = 1; end < parts.length; end++) expanded.add("/" + parts.slice(0, end).join("/"));
    }
    window.sidebar.restoreState({width: 330, expanded: [...expanded]});
    window.sidebar.refresh(true);
    window.tabs.refresh();
    return window.tabs.saveState();
  })()`);
}

async function snapshot(debuggerClient) {
  return debuggerClient.evaluate(`(() => {
    const keys = window.log.getFieldKeys().filter(key => key.endsWith("/BatteryVoltage"));
    return {
      title: document.title,
      displayClock: window.log.getDisplayClock(),
      timeline: window.selection.getTimelineRange(),
      liveTime: window.selection.getCurrentLiveTime(),
      fields: keys.map(key => ({
        key,
        data: window.log.getNumber(key, -Infinity, Infinity),
        original: window.log.getTimestampSources(key, -Infinity, Infinity)
      })),
      sidebar: document.getElementById("fieldList").innerText,
      graph: window.tabs.saveState().tabs.filter(tab => tab.type === 1).map(tab => tab.controller)
    };
  })()`);
}

async function sendMainMessage(debuggerClient, name, data) {
  await debuggerClient.evaluate(`window.messagePort.onmessage({data:${JSON.stringify({ name, data })}})`);
}

async function verifyPair(debuggerClient, request, screenshotPath, mixed) {
  let first = await startNT4Fixture("127.0.0.1", 60, 0);
  const second = mixed ? await startFoxgloveFixture() : await startNT4Fixture("127.0.0.2", 3600, Math.PI / 2);
  try {
    await debuggerClient.evaluate(`Object.assign(window.preferences, {
      liveMode: "nt4", robotAddress: "127.0.0.1", liveSubscribeMode: "low-bandwidth", liveDiscard: -1
    })`);
    await sendMainMessage(debuggerClient, "start-live", "robot");
    await until(
      () => snapshot(debuggerClient),
      (state) => state.fields.some((field) => field.key === "NT:/BatteryVoltage"),
      "The legacy source retains its unprefixed field"
    );
    await configureGraph(debuggerClient, ["NT:/BatteryVoltage"]);
    let state = await until(
      () => snapshot(debuggerClient),
      (state) => state.fields[0]?.data?.timestamps.length > 2,
      "The legacy source supplies graph samples"
    );
    const legacyClock = state.displayClock;
    const legacySourceClock = state.fields[0].original[0].domain;
    console.log("PASS legacy NetworkTables connection retains NT:/BatteryVoltage");

    await first.close();
    first = null;
    state = await until(
      () => snapshot(debuggerClient),
      (value) => value.liveTime === null,
      "A legacy source disconnect releases the live timeline"
    );
    assert.deepEqual(
      state.fields.map((field) => field.key),
      ["NT:/BatteryVoltage"]
    );
    assert.deepEqual(state.displayClock, legacyClock);
    first = await startNT4Fixture("127.0.0.1", 120, 0);
    state = await until(
      () => snapshot(debuggerClient),
      (value) =>
        value.liveTime !== null &&
        value.fields[0]?.data?.timestamps.length > 3 &&
        value.fields[0].original.every((timestamp) => timestamp.seconds >= 120),
      "A legacy source reconnect supplies a fresh log and resumes its timeline"
    );
    assert.deepEqual(
      state.fields.map((field) => field.key),
      ["NT:/BatteryVoltage"]
    );
    assert.deepEqual(state.displayClock, legacyClock);
    assert.deepEqual(state.fields[0].original[0].domain, legacySourceClock);
    console.log("PASS legacy disconnect and reconnect preserve field paths and source clock");

    await sendMainMessage(debuggerClient, request.name, request.data);
    state = await until(
      () => snapshot(debuggerClient),
      (value) => value.fields.length === 2,
      "Both source namespaces announce their BatteryVoltage fields"
    );
    const keys = state.fields.map((field) => field.key);
    assert.notEqual(keys[0], keys[1]);
    await configureGraph(debuggerClient, keys);
    state = await until(
      () => snapshot(debuggerClient),
      (value) => value.fields.every((field) => field.data?.timestamps.length > 25),
      "Both low-bandwidth sources supply graph samples"
    );
    const firstKey = state.fields.find((field) => field.original[0].seconds < 1000)?.key;
    const secondKey = state.fields.find((field) => field.original[0].seconds > 1000)?.key;
    assert(firstKey && secondKey, "The displayed sources retain their unrelated original clock epochs");
    assert.notDeepEqual(state.fields[0].original[0].domain, state.fields[1].original[0].domain);
    assert(state.liveTime !== null, "The shared timeline is connected");
    assert(
      Math.abs(state.fields[0].data.timestamps.at(-1) - state.fields[1].data.timestamps.at(-1)) < 2,
      "The two curves share display coordinates despite their unrelated source epochs"
    );
    console.log("PASS same topic appears under two namespaces with independent original clocks");
    console.log("PASS both curves share timeline coordinates despite unrelated source epochs");
    console.log("PASS both sources receive low-bandwidth subscriptions and graph samples");

    const before = state.fields.find((field) => field.key === secondKey).data;
    await first.close();
    first = null;
    await delay(1500);
    state = await until(
      () => snapshot(debuggerClient),
      (value) =>
        value.fields.find((field) => field.key === secondKey)?.data?.timestamps.length > before.timestamps.length + 10,
      "The second source continues appending while the first is disconnected"
    );
    assert(state.liveTime !== null, "A peer disconnect keeps the shared live timeline connected");
    const peerBeforeReconnect = state.fields.find((field) => field.key === secondKey).data;
    console.log("PASS disconnecting one fixture leaves the other source and shared timeline active");

    first = await startNT4Fixture("127.0.0.1", 180, 0);
    state = await until(
      () => snapshot(debuggerClient),
      (value) => value.fields.find((field) => field.key === firstKey)?.original?.some((time) => time.seconds >= 180),
      "The first source reconnects under its existing namespace"
    );
    const peerAfterReconnect = state.fields.find((field) => field.key === secondKey).data;
    assert(peerAfterReconnect.timestamps.length >= peerBeforeReconnect.timestamps.length);
    assert.deepEqual(
      peerAfterReconnect.timestamps.slice(0, peerBeforeReconnect.timestamps.length),
      peerBeforeReconnect.timestamps
    );
    assert.deepEqual(peerAfterReconnect.values.slice(0, peerBeforeReconnect.values.length), peerBeforeReconnect.values);
    console.log("PASS reconnecting one fixture preserves the other source's samples");

    await until(
      () => snapshot(debuggerClient),
      (value) => value.fields.every((field) => field.data?.timestamps.length > 40),
      "Both reconnected traces have enough samples for the screenshot"
    );
    await debuggerClient.evaluate(`(() => {
      const range = window.log.getTimestampRange();
      window.selection.setTimelineRange([Math.max(range[0], range[1] - 10), range[1]], false);
    })()`);
    await delay(500);
    state = await snapshot(debuggerClient);
    assert.equal(state.graph[0].leftSources.length, 2);
    assert.equal((state.sidebar.match(/BatteryVoltage/g) ?? []).length, 2);
    const screenshot = await debuggerClient.call("Page.captureScreenshot", { format: "png" });
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    console.log(`Screenshot saved to ${screenshotPath}`);
    console.log(
      JSON.stringify({
        displayClock: state.displayClock,
        timeline: state.timeline,
        fields: state.fields.map((field) => ({
          key: field.key,
          samples: field.data.timestamps.length,
          firstOriginal: field.original[0],
          latestDisplay: field.data.timestamps.at(-1)
        }))
      })
    );
    await sendMainMessage(debuggerClient, "stop-live", "/Live1");
    state = await snapshot(debuggerClient);
    assert.equal(state.fields.length, 1);
    assert.equal(state.fields[0].key, secondKey);
    assert(state.liveTime !== null, "Targeted disconnect leaves the peer timeline active");
    await sendMainMessage(debuggerClient, "stop-live", "/Live2");
    state = await snapshot(debuggerClient);
    assert.equal(state.liveTime, null, "Stopping the final source safely disconnects the timeline");
    console.log("PASS targeted disconnect preserves the peer and final disconnect safely stops the timeline");
  } finally {
    if (first) await first.close();
    await second.close();
  }
}

async function main() {
  const mixed = process.argv.includes("--mixed");
  const screenshotPath = path.resolve(
    process.argv.find((argument) => argument.startsWith("--screenshot="))?.slice("--screenshot=".length) ??
      `/tmp/terrascope-${mixed ? "mixed" : "multiple"}-live-sources.png`
  );
  const debuggerClient = await connectDebugger(process.env.CDP_PORT ?? 9222);
  try {
    await debuggerClient.call("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await until(
      () => debuggerClient.evaluate("!!window.preferences && !!window.messagePort && !!window.tabs"),
      Boolean,
      "The hub has initialized"
    );
    await verifyPair(
      debuggerClient,
      {
        name: "add-live",
        data: { sourceType: "robot", mode: mixed ? "foxglove" : "nt4", address: mixed ? "127.0.0.1:8765" : "127.0.0.2" }
      },
      screenshotPath,
      mixed
    );
  } finally {
    try {
      await sendMainMessage(debuggerClient, "stop-live", "/Live1");
      await sendMainMessage(debuggerClient, "stop-live", "/Live2");
    } finally {
      debuggerClient.close();
    }
  }
}

module.exports = { startNT4Fixture, connectDebugger, until, configureGraph, snapshot, verifyPair };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
