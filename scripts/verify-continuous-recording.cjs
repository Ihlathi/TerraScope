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
const { connectDebugger, until } = require("./verify-multiple-live-sources.cjs");

async function fixture(host, phase) {
  const started = performance.now();
  const now = () => 60 + (performance.now() - started) / 1000;
  const sent = new Map();
  const subscriptions = [];
  const topics = ["/BatteryVoltage", "/Unselected/HiddenSignal"];
  const server = http.createServer((_, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end("TerraScope recording fixture");
  });
  const sockets = new WebSocketServer({
    server,
    handleProtocols: (protocols) =>
      protocols.has("networktables.first.wpi.edu") ? "networktables.first.wpi.edu" : false
  });
  const timers = new Set();
  sockets.on("connection", (socket) => {
    const active = new Map();
    socket.send(
      JSON.stringify(
        topics.map((name, index) => ({
          method: "announce",
          params: { id: index + 1, name, type: "double", properties: { unit: "V", mutable: false } }
        }))
      )
    );
    const send = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const seconds = now();
      topics.forEach((topic, index) => {
        if (
          ![...active.values()].some(
            (subscription) =>
              !subscription.options.topicsonly &&
              subscription.topics.some((prefix) =>
                subscription.options.prefix ? topic.startsWith(prefix) : topic === prefix
              )
          )
        ) {
          return;
        }
        const timestamp = Math.round(seconds * 1e6);
        const value = index === 0 ? 12 + 0.7 * Math.sin(seconds * 1.6 + phase) : 2 + Math.cos(seconds + phase);
        sent.set(`${topic}:${timestamp}`, value);
        socket.send(encode([index + 1, timestamp, 1, value]));
      });
    };
    socket.on("message", (bytes, binary) => {
      if (binary) {
        for (const message of decodeMulti(bytes)) {
          if (message[0] === -1) socket.send(encode([-1, Math.round(now() * 1e6), 2, message[3]]));
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
        send();
      }
    });
    const timer = setInterval(send, 50);
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
    sent,
    subscriptions,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function mainDebugger(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  assert(targets[0]?.webSocketDebuggerUrl, "The Electron main inspector is available");
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  return {
    evaluate: async (expression) => {
      const id = ++nextId;
      const result = new Promise((resolve) => pending.set(id, resolve));
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true } }));
      const response = await result;
      assert(!response.error && !response.result?.exceptionDetails, JSON.stringify(response));
      return response.result?.result?.value;
    },
    close: () => socket.close()
  };
}

async function message(client, name, data) {
  await client.evaluate(`window.messagePort.onmessage({data:${JSON.stringify({ name, data })}})`);
}

async function graph(client, keys, title) {
  await client.evaluate(`(() => {
    const state = window.tabs.saveState();
    if (!state.tabs.some(tab => tab.type === 1)) window.tabs.addTab(1);
    const tab = window.tabs.saveState().tabs.find(tab => tab.type === 1);
    tab.title = ${JSON.stringify(title)};
    tab.controlsHeight = 180;
    tab.controller = {
      ...tab.controller,
      leftSources: ${JSON.stringify(keys)}.map((logKey,index) => ({
        type:'smooth',logKey,logType:'Number',visible:true,
        options:{color:index === 0 ? '#2b66a2' : '#d3931e',size:'bold'}
      })),
      rightSources:[],discreteSources:[],showRobotMode:false,leftLockedRange:[10.8,13.2]
    };
    window.tabs.restoreState({selected:0,tabs:[tab]});
    window.sidebar.restoreState({width:330,expanded:['/Live1','/Live1/NT','/Live2','/Live2/NT']});
    window.sidebar.refresh(true);
    window.tabs.refresh();
  })()`);
}

async function state(client) {
  return client.evaluate(`(() => ({
    title:document.title,
    status:document.getElementById('recording-status')?.textContent,
    recordingKind:document.getElementById('recording-controls')?.dataset.state,
    startDisabled:document.getElementById('recording-start')?.disabled,
    stopDisabled:document.getElementById('recording-stop')?.disabled,
    startHidden:document.getElementById('recording-start')?.hidden,
    stopHidden:document.getElementById('recording-stop')?.hidden,
    liveTime:window.selection.getCurrentLiveTime(),
    fields:window.log.getFieldKeys().filter(key => key.endsWith('/BatteryVoltage') || key.endsWith('/HiddenSignal'))
      .map(key => ({key,data:window.log.getNumber(key,-Infinity,Infinity)}))
  }))()`);
}

async function screenshot(client, target) {
  const capture = await client.call("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(target, Buffer.from(capture.data, "base64"));
}

async function main() {
  const output = path.resolve(process.env.RECORDING_OUTPUT ?? "build/recording-ui");
  const recordingPath = path.join(output, "two-sources.wpilog");
  await fs.mkdir(output, { recursive: true });
  await fs.rm(recordingPath, { force: true });
  const first = await fixture("127.0.0.1", 0);
  const second = await fixture("127.0.0.2", Math.PI / 2);
  const fixtures = [first, second];
  const client = await connectDebugger(process.env.CDP_PORT ?? 9222);
  const mainClient = await mainDebugger(process.env.MAIN_CDP_PORT ?? 9230);
  const keys = ["/Live1/NT:/BatteryVoltage", "/Live2/NT:/BatteryVoltage"];
  try {
    await mainClient.evaluate(`(() => {
      const electron = process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');
      electron.dialog.showSaveDialog = async () => ({canceled:false,filePath:${JSON.stringify(recordingPath)}});
    })()`);
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await until(
      () => client.evaluate("!!window.preferences && !!window.messagePort && !!window.tabs"),
      Boolean,
      "The hub initializes"
    );
    await client.evaluate(`Object.assign(window.preferences,{
      theme:'light',liveMode:'nt4',robotAddress:'127.0.0.1',liveSubscribeMode:'low-bandwidth',liveDiscard:1
    })`);
    await message(client, "start-live", "robot");
    await until(
      () => state(client),
      (value) => value.fields.some((field) => field.key === "NT:/BatteryVoltage"),
      "The first live source announces its topic"
    );
    await message(client, "add-live", { sourceType: "robot", mode: "nt4", address: "127.0.0.2" });
    await until(
      () => state(client),
      (value) => keys.every((key) => value.fields.some((field) => field.key === key)),
      "Both live namespaces announce their topics"
    );
    await graph(client, keys, "Live recording of two sources");
    await until(
      () => state(client),
      (value) => keys.every((key) => value.fields.find((field) => field.key === key)?.data?.values.length > 3),
      "Both curves receive live values"
    );
    const before = await state(client);
    assert(
      before.fields.filter((field) => field.key.endsWith("/HiddenSignal")).every((field) => !field.data?.values.length),
      "The unselected subtree has no samples before recording"
    );
    await client.evaluate("document.getElementById('recording-start').click()");
    await until(
      () => state(client),
      (value) => value.recordingKind === "recording" && value.stopHidden === false,
      "The recording controls show that recording started"
    );
    await delay(800);
    const firstSize = (await fs.stat(recordingPath)).size;
    assert(firstSize > 12, "The active recording already contains disk bytes");
    await delay(3200);
    const secondSize = (await fs.stat(recordingPath)).size;
    assert(secondSize > firstSize, "The file grows while recording, before Stop");
    const during = await state(client);
    assert(during.status.includes(path.basename(recordingPath)), "The destination is visible beside the controls");
    assert.equal(await client.evaluate("window.preferences.liveDiscard"), 1, "Recording keeps the discard window");
    await screenshot(client, path.join(output, "recording-controls.png"));
    console.log(`PASS file grows before stop: ${firstSize} to ${secondSize} bytes`);
    await client.evaluate("document.getElementById('recording-stop').click()");
    const stopped = await until(
      () => state(client),
      (value) => value.recordingKind === "stopped" && value.startDisabled === false && value.stopHidden === true,
      "Stop drains and re-enables Start"
    );
    const finalSize = (await fs.stat(recordingPath)).size;
    await delay(500);
    assert.equal((await fs.stat(recordingPath)).size, finalSize, "No samples reach disk after Stop");
    const { WPILOGDecoder } = require("../build/unit-test/hub/dataSources/wpilog/WPILOGDecoder.js");
    const bytes = new Uint8Array(await fs.readFile(recordingPath));
    const decoder = new WPILOGDecoder(bytes);
    assert(decoder.isValid(), "The existing reader accepts the recorded file");
    const entries = new Map();
    const samples = new Map();
    let consumed = 0;
    decoder.forEach((record, position) => {
      consumed = position;
      if (record.isStart()) entries.set(record.getStartData().entry, record.getStartData());
      else if (!record.isControl()) {
        const entry = entries.get(record.getEntry());
        if (!entry?.name.endsWith("/BatteryVoltage") && !entry?.name.endsWith("/HiddenSignal")) return;
        assert.equal(entry.type, "double");
        assert.equal(JSON.parse(entry.metadata).unit, "V", "The recording retains the source metadata");
        const match = /^\/Live([12])\/NT:(\/.*)$/.exec(entry.name);
        assert(match, `The recording has a stable source namespace: ${entry.name}`);
        const value = record.getDouble();
        assert.equal(fixtures[Number(match[1]) - 1].sent.get(`${match[2]}:${record.getTimestamp()}`), value);
        const list = samples.get(entry.name) ?? [];
        list.push({ timestamp: record.getTimestamp() / 1e6, value });
        samples.set(entry.name, list);
      }
    });
    assert.equal(consumed, bytes.length, "Stop leaves only complete WPILOG records");
    assert.equal(samples.size, 4, "Both selected and hidden topics from both sources reach disk");
    for (const [key, values] of samples) assert(values.length > 30, `${key} has continuous samples`);
    for (const key of keys) {
      assert(
        samples.get(key).length > during.fields.find((field) => field.key === key).data.values.length,
        "Disk retains samples removed by the live discard window"
      );
    }
    console.log("PASS four recorded fields retain every checked fixture timestamp and value");
    await message(client, "open-files", { files: [recordingPath], merge: false });
    await until(
      () => state(client),
      (value) => value.liveTime === null && keys.every((key) => value.fields.some((field) => field.key === key)),
      "The app reopens the actual recorded file through its historical reader"
    );
    await graph(client, keys, "Recorded WPILOG reopened from disk");
    const reopened = await until(
      () => state(client),
      (value) => keys.every((key) => value.fields.find((field) => field.key === key)?.data?.values.length > 30),
      "The existing reader loads both recorded curves"
    );
    for (const key of keys) {
      const actual = reopened.fields.find((field) => field.key === key).data;
      assert.deepEqual(
        actual.timestamps,
        samples.get(key).map((sample) => sample.timestamp)
      );
      assert.deepEqual(
        actual.values,
        samples.get(key).map((sample) => sample.value)
      );
    }
    await client.evaluate(`(() => {
      const range = window.log.getTimestampRange();
      window.selection.setTimelineRange(range,false);
      window.selection.setSelectedTime((range[0]+range[1])/2);
    })()`);
    await delay(700);
    await screenshot(client, path.join(output, "reopened-log.png"));
    console.log("PASS the reopened app graph matches the recorded timestamps and values");
    const result = {
      firstSize,
      secondSize,
      finalSize,
      discardWindowSeconds: 1,
      during,
      stoppedStatus: stopped.status,
      fields: [...samples].map(([key, values]) => ({
        key,
        count: values.length,
        first: values[0],
        last: values.at(-1)
      })),
      completeFile: consumed === bytes.length,
      reopenedTitle: reopened.title,
      samplesMatchFixture: true,
      reopenedSamplesMatchFile: true
    };
    await fs.writeFile(path.join(output, "ui-verification.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(`Evidence saved to ${output}`);
  } finally {
    try {
      await client.evaluate("document.getElementById('recording-stop')?.click()");
      await until(
        () => state(client),
        (value) => value.stopHidden === true,
        "The verifier stops any remaining recording",
        5000
      );
      await message(client, "stop-live", "/Live1");
      await message(client, "stop-live", "/Live2");
    } finally {
      await first.close();
      await second.close();
      client.close();
      mainClient.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
