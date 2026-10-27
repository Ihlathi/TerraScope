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
const repo = path.resolve(__dirname, "../../..");
const output = process.env.DROP_OUTPUT || __dirname;
const mode = process.env.DROP_MODE || "unsupported";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const pages = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = pages.find((entry) => entry.url.endsWith("/hub.html"));
  assert(page, "Electron hub available");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    pending.get(message.id)?.(message);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const seq = ++id;
      const timeout = setTimeout(() => {
        pending.delete(seq);
        reject(new Error(`CDP timeout for ${method}`));
      }, 20000);
      pending.set(seq, (message) => {
        clearTimeout(timeout);
        pending.delete(seq);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      });
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  try {
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    assert(await evaluate("!!window.preferences && !!window.messagePort"), "Hub ready");
    await evaluate(
      `window.dropPaths=[];document.addEventListener("drop",event=>{window.dropPaths=Array.from(event.dataTransfer.files,file=>window.electron.getFilePath(file))},{once:true,capture:true});window.dropMessages=[];window.dropSendMainMessage=window.sendMainMessage;window.sendMainMessage=(name,data)=>{if(name==='error'||name==='open-files-request')window.dropMessages.push({name,data});window.dropSendMainMessage(name,data)}`
    );
    const fixtures = path.join(repo, "build/drop-fixtures");
    fs.mkdirSync(fixtures, { recursive: true });
    const rejected = path.join(fixtures, "notes.unknown");
    fs.writeFileSync(rejected, "Unsupported file.\n");
    const supported = path.join(fixtures, "telemetry.csv");
    const field = mode === "mixed" ? "MixedDropValue" : "DropValue";
    fs.writeFileSync(supported, `Timestamp,${field}\n1,42\n2,84\n`);
    const files = mode === "mixed" ? [supported, rejected] : mode === "supported" ? [supported] : [rejected];
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await call("Input.dispatchDragEvent", { type, x: 600, y: 400, data });
    }
    await wait(800);
    const messages = await evaluate("window.dropMessages");
    assert.deepEqual(
      await evaluate("window.dropPaths"),
      files,
      "Real dropped File resolves through electron.getFilePath"
    );
    console.log(JSON.stringify(messages, null, 2));
    const error = {
      title: "Failed to open log",
      content: "The following files could not be opened because their file type is unsupported:\n\nnotes.unknown"
    };
    const expected = [];
    if (mode !== "unsupported") expected.push({ name: "open-files-request", data: { files: [supported] } });
    if (mode !== "supported") expected.push({ name: "error", data: error });
    assert.deepEqual(
      messages,
      expected,
      "Drop opens supported files and reports every rejected file through the existing error dialog"
    );
    if (mode !== "unsupported") {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`window.log.getFieldKeys().includes(${JSON.stringify(field)})`)) break;
        await wait(100);
      }
      assert.deepEqual(
        await evaluate(`window.log.getRange(${JSON.stringify(field)},-Infinity,Infinity)?.values`),
        [42, 84],
        "Supported CSV was parsed"
      );
    }
    if (mode !== "supported")
      fs.writeFileSync(path.join(output, "dialog-message.txt"), `${error.title}\n\n${error.content}\n`);
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, `${mode}-drop.png`), Buffer.from(shot.data, "base64"));
    console.log(
      `PASS (${mode}): real file paths verified, expected open/error messages matched, CSV values checked when supported, app state captured with Page.captureScreenshot.`
    );
  } finally {
    await evaluate(
      "if(window.dropSendMainMessage){window.sendMainMessage=window.dropSendMainMessage;delete window.dropSendMainMessage}"
    );
    socket.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
