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
const output = process.env.EXTENSION_OUTPUT || __dirname;
const mode = process.env.EXTENSION_MODE || "ds";
const baseline = process.env.EXTENSION_BASELINE === "1";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtures() {
  const directory = path.join(repo, "build/extension-fixtures");
  fs.mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "MATCH.practice.DSLOG");
  const eventsPath = path.join(directory, "MATCH.practice.DsEvEnTs");
  const seconds = 2082826800n + 1700000000n;
  const header = Buffer.alloc(20);
  header.writeInt32BE(4);
  header.writeBigInt64BE(seconds, 4);
  const records = Buffer.alloc(28);
  records.writeUInt16BE(12 * 256, 2);
  records.writeUInt16BE(12.5 * 256, 16);
  records[5] = records[19] = 255;
  fs.writeFileSync(logPath, Buffer.concat([header, records]));
  const text = Buffer.from("Companion event loaded");
  const event = Buffer.alloc(20);
  event.writeBigInt64BE(seconds);
  event.writeInt32BE(text.length, 16);
  fs.writeFileSync(eventsPath, Buffer.concat([header, event, text]));
  const csvPath = path.join(directory, "malformed.CSV");
  fs.writeFileSync(csvPath, "not a telemetry table\n");
  return { logPath, eventsPath, csvPath };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const files = fixtures();
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
  const open = async (file) => {
    await evaluate(
      `window.extensionPreviousLog=window.log;window.messagePort.onmessage({data:{name:'open-files',data:{files:[${JSON.stringify(
        file
      )}],merge:false}}})`
    );
  };
  const capture = async (name) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, name), Buffer.from(shot.data, "base64"));
  };
  try {
    assert(await evaluate("!!window.preferences && !!window.messagePort"), "Hub ready");
    const devtools = pages.find((entry) => entry.url.startsWith("devtools://"));
    if (devtools) await call("Target.closeTarget", { targetId: devtools.id });
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    await evaluate(
      "window.extensionErrors=[];window.extensionSendMainMessage=window.sendMainMessage;window.sendMainMessage=(name,data)=>{if(name==='error')window.extensionErrors.push(data);window.extensionSendMainMessage(name,data)}"
    );
    if (mode === "csv") {
      await open(files.csvPath);
      for (let i = 0; i < 100; i++) {
        if (await evaluate("window.extensionErrors.length>0")) break;
        await wait(100);
      }
      const errors = await evaluate("window.extensionErrors");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].title, "Failed to open log");
      assert.match(errors[0].content, baseline ? /Please try again/ : /required format of CSV files/);
      console.log(JSON.stringify(errors, null, 2));
      fs.writeFileSync(path.join(output, "dialog-message.txt"), `${errors[0].title}\n\n${errors[0].content}\n`);
      await capture("malformed-CSV-app.png");
    } else {
      const selected = mode === "events" ? files.eventsPath : files.logPath;
      await open(selected);
      for (let i = 0; i < 100; i++) {
        if (
          await evaluate(
            "window.log!==window.extensionPreviousLog && window.log.getFieldKeys().includes('/DSLog/BatteryVoltage')"
          )
        )
          break;
        if (await evaluate("window.extensionErrors.length>0")) break;
        await wait(100);
      }
      const actual = await evaluate(
        "({battery:window.log.getRange('/DSLog/BatteryVoltage',-Infinity,Infinity)?.values,events:window.log.getRange('/DSEvents',-Infinity,Infinity)?.values,errors:window.extensionErrors})"
      );
      console.log(JSON.stringify({ selected, ...actual }, null, 2));
      assert.deepEqual(actual.battery, [12, 12.5]);
      assert.deepEqual(actual.errors, []);
      if (baseline) assert.equal(actual.events, undefined, "Baseline misses mixed-case companion");
      else assert.deepEqual(actual.events, ["Companion event loaded"]);
      await evaluate(
        "window.tabs.restoreState({selected:0,tabs:[{type:4,title:'DS telemetry and companion events',controller:['/DSLog/BatteryVoltage','/DSEvents'],controlsHeight:0}]});window.selection.setSelectedTime(0)"
      );
      await wait(500);
      await capture(mode === "events" ? "mixed-DSEvents-app.png" : "uppercase-DSLOG-app.png");
    }
    console.log(`PASS (${baseline ? "baseline " : ""}${mode}): real file opened and observed result matched.`);
  } finally {
    await evaluate(
      "if(window.extensionSendMainMessage){window.sendMainMessage=window.extensionSendMainMessage;delete window.extensionSendMainMessage}"
    );
    socket.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
