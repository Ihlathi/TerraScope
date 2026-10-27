// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const response = JSON.parse(raw);
    if (pending.has(response.id)) {
      pending.get(response.id)(response);
      pending.delete(response.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const seq = ++id;
      const timer = setTimeout(() => {
        pending.delete(seq);
        reject(new Error("CDP timeout: " + method));
      }, 20000);
      pending.set(seq, (response) => {
        clearTimeout(timer);
        response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result);
      });
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
  return {
    socket,
    call,
    evaluate: async (expression) => {
      const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
  };
}

(async () => {
  const pages = () => fetch("http://127.0.0.1:9222/json/list").then((response) => response.json());
  const hub = await connect((await pages()).find((page) => page.url.endsWith("/hub.html")));
  let satellite;
  try {
    assert(
      await hub.evaluate("!!window.tabs.tabList[0].controller.getURDFModel()"),
      "Run the URDF verifier before this satellite check"
    );
    await hub.evaluate("window.tabs.newSatellite()");
    let page;
    for (let i = 0; i < 100; i++) {
      page = (await pages()).find((page) => page.url.endsWith("/satellite.html"));
      if (page) break;
      await wait(100);
    }
    assert(page, "3D satellite window opened");
    satellite = await connect(page);
    await satellite.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `
      window.urdfTransportEvidence = {frames:0,resources:0,modelId:null,modelInFrame:false,links:0};
      window.addEventListener('message', event => {
        if (event.data !== 'port') return;
        event.ports[0].addEventListener('message', event => {
          if (event.data.name !== 'render') return;
          const update = event.data.data, evidence = window.urdfTransportEvidence;
          if (Object.hasOwn(update,'urdfModel')) {evidence.resources++;evidence.modelId=update.urdfModel?.id??null;}
          const object = update.command?.objects.find(object=>object.type==='urdf');
          if (object) {evidence.frames++;evidence.links=object.links.length;evidence.modelInFrame ||= Object.hasOwn(object,'robot');evidence.frameId=object.modelId;}
        });
      });`
    });
    await satellite.call("Page.reload");
    let state;
    for (let i = 0; i < 120; i++) {
      state = await satellite.evaluate("window.urdfTransportEvidence");
      if (state?.frames >= 30) break;
      await wait(100);
    }
    assert(state?.frames >= 30, "At least 30 actual satellite frames received");
    assert.equal(state.resources, 1, "Reload receives robot resource exactly once");
    assert.equal(state.modelId, state.frameId);
    assert(state.links > 0);
    assert.equal(state.modelInFrame, false);
    await wait(1200);
    const shot = await satellite.call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(__dirname, "urdf-satellite.png"), Buffer.from(shot.data, "base64"));
    fs.writeFileSync(path.join(__dirname, "satellite-observations.json"), JSON.stringify(state, null, 2) + "\n");
    console.log(
      "PASS: real 3D satellite reload receives one robot resource, at least 30 model-free pose commands, and renders the robot."
    );
  } finally {
    satellite?.socket.close();
    hub.socket.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
