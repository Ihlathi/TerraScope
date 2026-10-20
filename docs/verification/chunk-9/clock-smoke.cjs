// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const repoRoot = path.resolve(__dirname, "../../..");
const WebSocket = require(path.join(repoRoot, "node_modules/ws"));
const baselineMode = process.argv.includes("--baseline");
const evidence = path.resolve(
  process.argv.find((arg, index) => index > 1 && !arg.startsWith("--")) || path.join(repoRoot, "build/clock-smoke")
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(evidence, { recursive: true });

function rlogSample(first, timestamp, voltage) {
  const key = Buffer.from("BatteryVoltage");
  const type = Buffer.from("double");
  const bytes = Buffer.alloc(
    (first ? 1 : 0) + 1 + 8 + (first ? 1 + 2 + 2 + key.length + 2 + type.length : 0) + 1 + 2 + 2 + 8
  );
  let offset = 0;
  if (first) bytes[offset++] = 2;
  bytes[offset++] = 0;
  bytes.writeDoubleBE(timestamp, offset);
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
  return bytes;
}

function makeFixtures() {
  const fixtures = path.join(evidence, "fixtures");
  const codec = path.join(evidence, "codec");
  fs.mkdirSync(fixtures, { recursive: true });
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules/typescript/bin/tsc"),
      path.join(repoRoot, "src/hub/dataSources/wpilog/WPILOGEncoder.ts"),
      "--target",
      "ES2022",
      "--module",
      "commonjs",
      "--skipLibCheck",
      "--outDir",
      codec
    ],
    { cwd: repoRoot, stdio: "pipe" }
  );
  const { WPILOGEncoder, WPILOGEncoderRecord } = require(path.join(codec, "WPILOGEncoder.js"));
  const wpilog = new WPILOGEncoder("TerraScope timestamp compatibility fixture");
  wpilog.add(
    WPILOGEncoderRecord.makeControlStart(1000000, {
      entry: 1,
      name: "BatteryVoltage",
      type: "double",
      metadata: ""
    })
  );
  wpilog.add(WPILOGEncoderRecord.makeDouble(1, 1000000, 12.4));
  wpilog.add(WPILOGEncoderRecord.makeDouble(1, 2000000, 12.8));
  fs.writeFileSync(path.join(fixtures, "sample.wpilog"), wpilog.getEncoded());
  fs.writeFileSync(
    path.join(fixtures, "sample.rlog"),
    Buffer.concat([rlogSample(true, 1, 12.4), rlogSample(false, 2, 12.8)])
  );
  fs.writeFileSync(
    path.join(fixtures, "sample.csv"),
    'Timestamp,BatteryVoltage,Mode\n1,12.4,"auto"\n2,12.8,"teleop"\n'
  );
  for (const extension of ["mcap", "json"]) {
    fs.copyFileSync(
      path.join(repoRoot, `src/hub/dataSources/${extension}/fixtures/sample.${extension}`),
      path.join(fixtures, `sample.${extension}`)
    );
  }
  return ["wpilog", "rlog", "mcap", "csv", "json"].map((format) => ({
    format,
    file: path.join(fixtures, `sample.${format}`)
  }));
}

async function cdp() {
  let page;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const pages = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      page = pages.find((item) => item.url.endsWith("/hub.html"));
      if (page) break;
    } catch {}
    await wait(250);
  }
  assert(page, "the Electron hub is available on port 9222");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (pending.has(message.id)) {
      const request = pending.get(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Error(JSON.stringify(message.error)));
      else request.resolve(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP ${method} timed out`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.error || response.result?.exceptionDetails) throw Error(JSON.stringify(response));
    return response.result.result.value;
  };
  return { call, evaluate, close: () => socket.close() };
}

(async () => {
  const fixtures = makeFixtures();
  const client = await cdp();
  const baselinePath = path.join(__dirname, "baseline-results.json");
  const baseline = baselineMode ? null : JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const results = [];
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await client.evaluate("!!window.preferences && !!window.messagePort?.onmessage && !!window.tabs")) break;
      await wait(100);
    }
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 850,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.evaluate(
      "window.preferences = {...window.preferences, timestamps: 'original', hasScrolledTimeline: true}"
    );
    for (const fixture of fixtures) {
      await client.evaluate(
        `window.messagePort.onmessage({data:{name:'open-files',data:{files:[${JSON.stringify(
          fixture.file
        )}],merge:false}}})`
      );
      let state;
      for (let attempt = 0; attempt < 150; attempt++) {
        state = JSON.parse(
          await client.evaluate(
            `JSON.stringify((()=>{const battery=window.log.getNumber('BatteryVoltage',-Infinity,Infinity);return {title:document.title,battery:battery?{timestamps:battery.timestamps,values:battery.values}:null,fieldCount:window.log.getFieldKeys().length}})())`
          )
        );
        if (state.fieldCount > 0) {
          await client.evaluate(
            "(()=>{const graph=window.tabs.tabList.find(tab=>tab.controller?.leftSourceList);if(graph && !graph.controller.leftSourceList.getState().some(source=>source.logKey==='BatteryVoltage'))graph.controller.leftSourceList.addField('BatteryVoltage');})()"
          );
        }
        if (state.title.includes(path.basename(fixture.file)) && state.battery?.values.length === 2) break;
        await wait(100);
      }
      assert(state.title.includes(path.basename(fixture.file)), `${fixture.format} is the active file`);
      assert.deepEqual(
        state.battery,
        { timestamps: [1, 2], values: [12.4, 12.8] },
        `${fixture.format} keeps original sample timestamps`
      );
      const samples = JSON.parse(
        await client.evaluate(
          `JSON.stringify(Object.fromEntries(window.log.getFieldKeys().sort().map(key=>{const data=window.log.getRange(key,-Infinity,Infinity);return [key,{type:window.log.getType(key),data:data?{timestamps:data.timestamps,values:data.values}:null}]})),(_,value)=>value instanceof Uint8Array?Array.from(value):value)`
        )
      );
      if (baseline)
        assert.deepEqual(
          samples,
          baseline.find((item) => item.format === fixture.format).samples,
          `${fixture.format} matches main`
        );
      const domain = await client.evaluate("document.querySelector('.timeline-clock-domain')?.textContent ?? null");
      if (!baselineMode) {
        assert(domain?.toLowerCase().includes("log"), `${fixture.format} timeline displays its log clock domain`);
        assert(
          await client.evaluate(
            "(()=>{const label=document.querySelector('.timeline-clock-domain');return !!label && label.getBoundingClientRect().width>0 && label.getBoundingClientRect().height>0 && getComputedStyle(label).visibility==='visible';})()"
          ),
          "the clock label is visible beside playback controls"
        );
      }
      await client.evaluate(
        "window.selection.setTimelineRange([0.9,2.1],false); window.selection.setSelectedTime(1.5)"
      );
      await wait(500);
      const screenshot = await client.call("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(evidence, fixture.format + ".png"), Buffer.from(screenshot.result.data, "base64"));
      if (!baselineMode) {
        await client.evaluate("window.tabs.setSelected(window.tabs.tabList.findIndex(tab => tab.type === 2))");
        await wait(500);
        assert(
          await client.evaluate("document.querySelector('.timeline').getBoundingClientRect().height > 0"),
          "the shared timeline is visible"
        );
        const timeline = await client.call("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(
          path.join(evidence, fixture.format + "-timeline.png"),
          Buffer.from(timeline.result.data, "base64")
        );
        await client.evaluate("window.tabs.setSelected(window.tabs.tabList.findIndex(tab => tab.type === 1))");
      }
      const result = { format: fixture.format, result: "PASS", battery: state.battery, domain, samples };
      results.push(result);
      console.log(
        JSON.stringify({
          format: fixture.format,
          result: "PASS",
          battery: state.battery,
          domain,
          fields: Object.keys(samples).length
        })
      );
    }
    if (!baselineMode) {
      const bag = path.join(repoRoot, "src/hub/dataSources/ros2/fixtures/sample.db3");
      await client.evaluate(
        `window.messagePort.onmessage({data:{name:'open-files',data:{files:[${JSON.stringify(bag)}],merge:false}}})`
      );
      let battery;
      for (let attempt = 0; attempt < 150; attempt++) {
        battery = await client.evaluate("window.log.getNumber('/battery/data',-Infinity,Infinity)");
        if (battery?.values.length === 5) break;
        await wait(100);
      }
      assert.deepEqual(
        battery,
        { timestamps: [1, 1.5, 2, 2.5, 3], values: [12.4, 12.1, 11.8, 12.2, 12.6] },
        "the bundled sql.js runtime still opens ROS 2 bags"
      );
      const result = { format: "ros2", result: "PASS", battery };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2) + "\n");
    if (baselineMode) fs.writeFileSync(baselinePath, JSON.stringify(results, null, 2) + "\n");
  } finally {
    client.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
