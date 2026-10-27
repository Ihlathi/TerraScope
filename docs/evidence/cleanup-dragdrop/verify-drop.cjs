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
    const data = { items: [], files: [rejected], dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await call("Input.dispatchDragEvent", { type, x: 600, y: 400, data });
    }
    await wait(800);
    const messages = await evaluate("window.dropMessages");
    assert.deepEqual(
      await evaluate("window.dropPaths"),
      [rejected],
      "Real dropped File resolves through electron.getFilePath"
    );
    console.log(JSON.stringify(messages, null, 2));
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, "unsupported-drop.png"), Buffer.from(shot.data, "base64"));
    assert.deepEqual(
      messages,
      [
        {
          name: "error",
          data: {
            title: "Failed to open log",
            content: "The following files could not be opened because their file type is unsupported:\n\nnotes.unknown"
          }
        }
      ],
      "Unsupported drop reports every rejected file through the existing error dialog"
    );
    fs.writeFileSync(
      path.join(output, "dialog-message.txt"),
      `${messages[0].data.title}\n\n${messages[0].data.content}\n`
    );
    console.log(
      "PASS: real file dropped through CDP, unsupported file reported through error IPC, app state captured with Page.captureScreenshot."
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
