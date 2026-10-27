// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function loadFunction(file: string, name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(declaration, `${name} exists in ${file}`);
  const script = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return runInNewContext(script + "\n" + name, context);
}

test("Lite accepts satellite clears without an unknown-message warning", async () => {
  const warnings: unknown[][] = [];
  const handle = loadFunction("src/main/lite/main.ts", "handleHubMessage", {
    console: { warn: (...args: unknown[]) => warnings.push(args) }
  });
  await handle({ name: "clear-satellite", data: { uuid: "image" } });
  assert.deepEqual(warnings, []);
  await handle({ name: "unknown-for-test" });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "Unknown message from hub");
});

function mainSetup(type = 13) {
  const windows: FakeWindow[] = [];
  class FakeWindow extends EventEmitter {
    id = windows.length + 1;
    visible = false;
    webContents = Object.assign(new EventEmitter(), {
      postMessage() {},
      setWindowOpenHandler() {}
    });
    constructor() {
      super();
      windows.push(this);
    }
    show = () => {
      this.visible = true;
      this.emit("show");
    };
    isVisible() {
      return this.visible;
    }
    setMenu() {}
    setMenuBarVisibility() {}
    loadFile() {}
  }
  const messages: { window: { id: number }; name: string; data: any }[] = [];
  const satelliteWindows: Record<string, FakeWindow[]> = {};
  const hub = { id: 100, isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) };
  const context = {
    BrowserWindow: FakeWindow,
    TabType: { Image: 13, Field3d: 3 },
    SATELLITE_DEFAULT_WIDTH: 600,
    SATELLITE_DEFAULT_HEIGHT: 400,
    WINDOW_ICON: "icon",
    __dirname: "/app",
    path,
    hubWindows: [hub],
    satelliteWindows,
    windowPorts: {},
    MessageChannelMain: class {
      port1 = {};
      port2 = Object.assign(new EventEmitter(), { start() {} });
    },
    advantageScopeAssets: null,
    powerMonitor: Object.assign(new EventEmitter(), { isOnBatteryPower: () => false }),
    stateTracker: {
      saveSatelliteIds() {},
      getRendererState: () => ({ type, visualizer: null })
    },
    sendActiveSatellites() {},
    sendAllPreferences() {},
    sendMessage: (window: { id: number }, name: string, data: any) => messages.push({ window, name, data })
  };
  const create = loadFunction("src/main/electron/main.ts", "createSatellite", context);
  const handle = loadFunction("src/main/electron/main.ts", "handleHubMessage", context);
  return {
    windows,
    messages,
    hub,
    handle,
    context,
    create() {
      create({ parentWindow: hub, uuid: "image", type });
      return windows.at(-1)!;
    }
  };
}

test("satellite requests its frame only after both renderer readiness and visibility", () => {
  for (const showFirst of [false, true]) {
    const app = mainSetup();
    const satellite = app.create();
    assert.equal(app.messages.length, 0);
    if (showFirst) satellite.show();
    else satellite.webContents.emit("dom-ready");
    assert.equal(app.messages.filter((message) => message.name === "refresh-satellite").length, 0);
    if (showFirst) satellite.webContents.emit("dom-ready");
    else satellite.show();
    const requests = app.messages.filter((message) => message.name === "refresh-satellite");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].data.uuid, "image");
    assert.equal(requests[0].data.satelliteId, satellite.id);
    assert(app.messages.findIndex((message) => message.name === "set-type") < app.messages.indexOf(requests[0]));
  }
});

test("a second window, reload, and hide/show each request the current frame for that window", () => {
  const app = mainSetup();
  const first = app.create();
  first.webContents.emit("dom-ready");
  first.show();
  const second = app.create();
  second.show();
  second.webContents.emit("dom-ready");
  first.webContents.emit("did-start-loading");
  first.webContents.emit("dom-ready");
  second.visible = false;
  second.show();
  const requests = app.messages.filter((message) => message.name === "refresh-satellite");
  assert.deepEqual(
    requests.map((message) => message.data.satelliteId),
    [first.id, second.id, first.id, second.id]
  );
});

test("main sends targeted pixels only to their destination and accepts title-only updates", async () => {
  const app = mainSetup();
  const first = app.create();
  const second = app.create();
  first.visible = true;
  const command = { id: "image/1", image: { rgba: new Uint8Array([1, 2, 3, 255]) } };
  await app.handle(app.hub, {
    name: "update-satellite",
    data: { uuid: "image", title: "Camera", command, satelliteId: second.id }
  });
  assert.deepEqual(
    app.messages.map((message) => message.window.id),
    [second.id]
  );
  assert.equal(app.messages[0].data.command, command);
  await app.handle(app.hub, { name: "update-satellite", data: { uuid: "image", title: "Renamed camera" } });
  assert.equal(app.messages[1].window.id, first.id);
  assert.equal(app.messages[1].data.title, "Renamed camera");
  assert.equal(app.messages[1].data.command, undefined);
  await app.handle(app.hub, { name: "clear-satellite", data: { uuid: "image" } });
  assert.deepEqual(
    app.messages.slice(2).map((message) => [message.window.id, message.name]),
    [
      [first.id, "clear-renderer"],
      [second.id, "clear-renderer"]
    ]
  );
});

test("reload before the first state save still initializes the image renderer", () => {
  const app = mainSetup();
  app.context.stateTracker.getRendererState = () => undefined as any;
  const satellite = app.create();
  satellite.show();
  satellite.webContents.emit("dom-ready");
  satellite.webContents.emit("did-start-loading");
  satellite.webContents.emit("dom-ready");
  assert.equal(app.messages.filter((message) => message.name === "set-type").length, 2);
  assert.equal(app.messages.filter((message) => message.name === "refresh-satellite").length, 2);
});

test("3D satellite initialization, reload, and show request the current model resource", () => {
  const app = mainSetup(3);
  const satellite = app.create();
  satellite.show();
  assert.equal(app.messages.filter((message) => message.name === "refresh-satellite").length, 0);
  satellite.webContents.emit("dom-ready");
  satellite.webContents.emit("did-start-loading");
  satellite.webContents.emit("dom-ready");
  satellite.visible = false;
  satellite.show();
  const requests = app.messages.filter((message) => message.name === "refresh-satellite");
  assert.deepEqual(
    requests.map((message) => message.data.satelliteId),
    [satellite.id, satellite.id, satellite.id]
  );
});

test("main forwards one-time 3D resources, preserves absent resources, and forwards explicit clears", async () => {
  const app = mainSetup(3);
  const first = app.create();
  const second = app.create();
  first.visible = true;
  second.visible = true;
  const command = { objects: [{ type: "urdf", modelId: "robot-1", links: [] }] };
  const model = {
    id: "robot-1",
    robot: { links: [{ name: "base", visuals: [] }] },
    baseUrl: null,
    packageRootUrl: null
  };
  await app.handle(app.hub, {
    name: "update-satellite",
    data: { uuid: "image", command, title: "Robot", urdfModel: model, satelliteId: second.id }
  });
  assert.equal(app.messages.length, 1);
  assert.equal(app.messages[0].window.id, second.id);
  assert.equal(app.messages[0].data.urdfModel, model);
  await app.handle(app.hub, { name: "update-satellite", data: { uuid: "image", command, title: "Robot" } });
  assert.ok(app.messages.slice(1).every((message) => !Object.hasOwn(message.data, "urdfModel")));
  await app.handle(app.hub, {
    name: "update-satellite",
    data: { uuid: "image", command, title: "Robot", urdfModel: null }
  });
  assert.ok(
    app.messages
      .slice(-2)
      .every((message) => Object.hasOwn(message.data, "urdfModel") && message.data.urdfModel === null)
  );
});
