// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const repoRoot = path.resolve(__dirname, "../../..");
const WebSocket = require(path.join(repoRoot, "node_modules/ws"));
const { startFixtureServer } = require(
  path.join(repoRoot, "build/unit-test/hub/dataSources/foxglove/fixtureServer.js")
);
const evidence = process.argv[2] || path.join(repoRoot, "build/live-transport-smoke");
fs.mkdirSync(evidence, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function rlogSample(first, time, voltage) {
  const key = Buffer.from("BatteryVoltage");
  const type = Buffer.from("double");
  const bytes = Buffer.alloc(
    (first ? 1 : 0) + 1 + 8 + (first ? 1 + 2 + 2 + key.length + 2 + type.length : 0) + 1 + 2 + 2 + 8
  );
  let offset = 0;
  if (first) bytes[offset++] = 2;
  bytes[offset++] = 0;
  bytes.writeDoubleBE(time, offset);
  offset += 8;
  if (first) {
    bytes[offset++] = 1;
    bytes.writeInt16BE(1, offset);
    offset += 2;
    bytes.writeInt16BE(key.length, offset);
    offset += 2;
    key.copy(bytes, offset);
    offset += key.length;
    bytes.writeInt16BE(type.length, offset);
    offset += 2;
    type.copy(bytes, offset);
    offset += type.length;
  }
  bytes[offset++] = 2;
  bytes.writeInt16BE(1, offset);
  offset += 2;
  bytes.writeInt16BE(8, offset);
  offset += 2;
  bytes.writeDoubleBE(voltage, offset);
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return frame;
}
async function tcpFixture(port = 0, voltage = 12.4) {
  const timers = new Set();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let sequence = 1;
    socket.on("error", () => {});
    socket.on("data", () => {});
    const first = rlogSample(true, sequence++, voltage);
    socket.write(first.subarray(0, 2));
    const partial = setTimeout(() => socket.write(first.subarray(2)), 25);
    const interval = setInterval(() => {
      if (!socket.destroyed)
        socket.write(Buffer.concat([rlogSample(false, sequence++, voltage), rlogSample(false, sequence++, voltage)]));
    }, 250);
    timers.add(partial);
    timers.add(interval);
    socket.on("close", () => {
      clearTimeout(partial);
      clearInterval(interval);
      timers.delete(partial);
      timers.delete(interval);
      sockets.delete(socket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((r) => {
        for (const t of timers) {
          clearTimeout(t);
          clearInterval(t);
        }
        for (const s of sockets) s.destroy();
        server.close(r);
      })
  };
}
async function foxReplacementFixture(port, voltage) {
  const timers = new Set();
  const server = new WebSocket.WebSocketServer({
    port,
    handleProtocols: (protocols) => (protocols.has("foxglove.websocket.v1") ? "foxglove.websocket.v1" : false)
  });
  server.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        op: "serverInfo",
        name: "chunk7-reconnect-fixture",
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
    let subs = [];
    let sequence = 100;
    const send = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      for (const sub of subs) {
        const body =
          sub.channelId === 3
            ? Buffer.from([1, 2, 3])
            : Buffer.from(JSON.stringify(sub.channelId === 1 ? voltage : { x: 1.5, y: 2.5 }));
        const msg = Buffer.alloc(13 + body.length);
        msg[0] = 1;
        msg.writeUInt32LE(sub.id, 1);
        msg.writeBigUInt64LE(BigInt(sequence) * 1000000000n, 5);
        body.copy(msg, 13);
        socket.send(msg);
      }
      sequence++;
    };
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.op === "subscribe") {
        subs = msg.subscriptions;
        send();
      }
    });
    const timer = setInterval(send, 250);
    timers.add(timer);
    socket.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  await new Promise((r, j) => {
    server.once("listening", r);
    server.once("error", j);
  });
  return {
    port,
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        for (const c of server.clients) c.terminate();
        server.close(r);
      })
  };
}
async function cdp() {
  let pages;
  for (let i = 0; i < 60; i++) {
    try {
      pages = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      if (pages.some((p) => p.url.endsWith("/hub.html"))) break;
    } catch {}
    await wait(250);
  }
  const page = pages?.find((p) => p.url.endsWith("/hub.html"));
  assert(page, "hub page available");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    socket.once("open", r);
    socket.once("error", j);
  });
  let seq = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((r) => {
      const id = ++seq;
      pending.set(id, r);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.result?.exceptionDetails) throw Error(JSON.stringify(result.result.exceptionDetails));
    return result.result.result.value;
  };
  return { call, evaluate, close: () => socket.close() };
}
(async () => {
  let tcp = await tcpFixture();
  let fox = await startFixtureServer(0);
  const client = await cdp();
  const output = [];
  try {
    for (let i = 0; i < 80; i++) {
      if (await client.evaluate(`!!window.preferences && !!window.messagePort?.onmessage && !!window.tabs`)) break;
      await wait(100);
    }
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 850,
      deviceScaleFactor: 1,
      mobile: false
    });
    for (const mode of ["rlog", "foxglove"]) {
      const port = mode === "rlog" ? tcp.port : fox.port;
      await client.evaluate(
        `(()=>{ if(!window.preferences || !window.messagePort?.onmessage)throw Error('hub not initialized'); window.preferences={...window.preferences,liveMode:${JSON.stringify(
          mode
        )},robotAddress:${JSON.stringify(
          mode === "rlog" ? "127.0.0.1" : `127.0.0.1:${port}`
        )},rlogPort:${port},systemcoreStaticAddress:'',timestamps:'original'}; window.messagePort.onmessage({data:{name:'start-live',data:'robot'}}); return true;})()`
      );
      let state;
      for (let i = 0; i < 80; i++) {
        state = await client.evaluate(
          `JSON.stringify({title:document.title,fields:window.log.getFieldKeys(),voltage:window.log.getNumber('BatteryVoltage',-Infinity,Infinity)?.values,poseX:window.log.getNumber('pose/x',-Infinity,Infinity)?.values,poseY:window.log.getNumber('pose/y',-Infinity,Infinity)?.values,sceneType:window.log.getStructuredType('Scene'),range:window.log.getTimestampRange()})`
        );
        state = JSON.parse(state);
        if (state.voltage?.length > 0 && state.range[1] >= 3 && (mode !== "foxglove" || state.poseY?.length > 0)) break;
        await wait(100);
      }
      assert(state.voltage?.length > 0, mode + " voltage samples");
      assert.equal(state.voltage[0], 12.4);
      assert(!state.title.includes("Searching") && !state.title.includes("Error"), mode + " active title");
      if (mode === "foxglove") {
        assert.equal(state.poseX?.[0], 1.5);
        assert.equal(state.poseY?.[0], 2.5);
        assert.equal(state.sceneType, "foxglove.SceneUpdate");
      }
      await client.evaluate(
        `(()=>{const t=window.tabs.tabList.find(t=>t.controller?.leftSourceList); if(t && !t.controller.leftSourceList.getState().some(s=>s.logKey==='BatteryVoltage'))t.controller.leftSourceList.addField('BatteryVoltage'); return document.body.innerText})()`
      );
      await wait(700);
      const image = await client.call("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(evidence, mode + ".png"), Buffer.from(image.result.data, "base64"));
      const result = { mode, result: "PASS", ...state };
      output.push(result);
      console.log(JSON.stringify(result));
      if (mode === "rlog") {
        await tcp.close();
        tcp = await tcpFixture(port, 13.1);
      } else {
        await fox.close();
        fox = await foxReplacementFixture(port, 13.1);
      }
      let reconnected;
      for (let i = 0; i < 100; i++) {
        reconnected = JSON.parse(
          await client.evaluate(
            `JSON.stringify({title:document.title,voltage:window.log.getNumber('BatteryVoltage',-Infinity,Infinity)?.values,range:window.log.getTimestampRange()})`
          )
        );
        if (reconnected.voltage?.includes(13.1)) break;
        await wait(100);
      }
      assert(reconnected.voltage?.includes(13.1), mode + " receives replacement server value after reconnect");
      assert(
        !reconnected.title.includes("Searching") && !reconnected.title.includes("Error"),
        mode + " reconnect active title"
      );
      await wait(350);
      const reconnectImage = await client.call("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(
        path.join(evidence, mode + "-reconnected.png"),
        Buffer.from(reconnectImage.result.data, "base64")
      );
      const reconnectResult = { mode, result: "RECONNECT PASS", ...reconnected };
      output.push(reconnectResult);
      console.log(JSON.stringify(reconnectResult));
    }
    fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(output, null, 2));
  } finally {
    client.close();
    await tcp.close();
    await fox.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
