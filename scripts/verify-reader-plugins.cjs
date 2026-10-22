// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocket } = require("ws");
const { connectDebugger, until } = require("./verify-multiple-live-sources.cjs");

async function mainDebugger(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
      const response = await result;
      assert(!response.error && !response.result?.exceptionDetails, JSON.stringify(response));
      return response.result?.result?.value;
    },
    close: () => socket.close()
  };
}

async function main() {
  const output = path.resolve(process.env.READER_OUTPUT ?? "docs/evidence/chunk-18");
  await fs.mkdir(output, { recursive: true });
  const client = await connectDebugger(process.env.CDP_PORT ?? 9222);
  const mainClient = await mainDebugger(process.env.MAIN_CDP_PORT ?? 9230);
  const observations = {};
  try {
    if (process.argv.includes("--dialog")) {
      observations.filters = await mainClient.evaluate(`(() => {
        const electron = process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');
        const original = electron.dialog.showOpenDialog;
        electron.dialog.showOpenDialog = function(window, options) {
          globalThis.readerDialogFilters = options.filters;
          return original.call(this, window, options);
        };
        const window = electron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/hub.html'));
        const fileMenu = electron.Menu.getApplicationMenu().items.find(item => item.label === 'File');
        fileMenu.submenu.items.find(item => item.label === 'Open Log(s)...').click(undefined, window);
        return globalThis.readerDialogFilters;
      })()`);
      assert(observations.filters.some((filter) => filter.extensions.includes("mcap")));
      await fs.writeFile(
        path.join(output, "dialog-filters.json"),
        JSON.stringify(observations.filters, null, 2) + "\n"
      );
      console.log("Opened the native file dialog with " + observations.filters.length + " registered filters.");
      return;
    }
    const fixtures = [
      {
        name: "wpilog",
        file: "docs/evidence/chunk-16/two-sources.wpilog",
        keys: ["/Live1/NT:/BatteryVoltage", "/Live2/NT:/BatteryVoltage"]
      },
      { name: "mcap", file: "src/hub/dataSources/mcap/fixtures/sample.mcap", keys: ["BatteryVoltage"] }
    ];
    for (const fixture of fixtures) {
      await client.evaluate(
        `window.messagePort.onmessage({data:${JSON.stringify({
          name: "open-files",
          data: { files: [path.resolve(fixture.file)], merge: false }
        })}})`
      );
      await until(
        () => client.evaluate("window.log.getFieldKeys()"),
        (keys) => fixture.keys.every((key) => keys.includes(key)),
        `${fixture.name} fixture fields appeared`
      );
      await client.evaluate(`(() => {
        if (!window.tabs.saveState().tabs.some(tab => tab.type === 1)) window.tabs.addTab(1);
        const tab = window.tabs.saveState().tabs.find(tab => tab.type === 1);
        tab.title = ${JSON.stringify(fixture.name.toUpperCase() + " fixture")};
        tab.controlsHeight = 180;
        tab.controller = {...tab.controller,
          leftSources:${JSON.stringify(fixture.keys)}.map((logKey,index) => ({
            type:'smooth',logKey,logType:'Number',visible:true,
            options:{color:index === 0 ? '#2b66a2' : '#d3931e',size:'bold'}
          })),rightSources:[],discreteSources:[],showRobotMode:false,leftLockedRange:null};
        window.tabs.restoreState({selected:0,tabs:[tab]});
        window.sidebar.restoreState({width:330,expanded:['/Live1','/Live1/NT','/Live2','/Live2/NT','MCAP','MCAP/schemas']});
        window.sidebar.refresh(true);
        window.tabs.refresh();
      })()`);
      await until(
        () =>
          client.evaluate(
            `window.log.getNumber(${JSON.stringify(fixture.keys[0])},-Infinity,Infinity)?.values.length ?? 0`
          ),
        (count) => count > 0,
        `${fixture.name} samples decoded`
      );
      await delay(700);
      observations[fixture.name] = await client.evaluate(
        `({title:document.title,fields:window.log.getFieldKeys().sort(),samples:${JSON.stringify(
          fixture.keys
        )}.map(key => ({key,data:window.log.getNumber(key,-Infinity,Infinity)}))})`
      );
      const capture = await client.call("Page.captureScreenshot", { format: "png" });
      await fs.writeFile(path.join(output, `${fixture.name}.png`), Buffer.from(capture.data, "base64"));
    }
    await fs.writeFile(path.join(output, "ui-verification.json"), JSON.stringify(observations, null, 2) + "\n");
    console.log(
      "Opened WPILOG and MCAP fixtures through the app and captured their field lists, samples, and screenshots."
    );
  } finally {
    client.close();
    mainClient.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
