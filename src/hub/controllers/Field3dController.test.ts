// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import Log from "../../shared/log/Log";
import LoggableType from "../../shared/log/LoggableType";
import Field3dController from "./Field3dController";

function select(value = "") {
  return {
    value,
    selectedIndex: 0,
    options: [] as { value: string; text: string; textContent: string }[],
    replaceChildren(...options: { value: string; text: string; textContent: string }[]) {
      this.options = options;
    },
    appendChild(option: { value: string; text: string; textContent: string }) {
      this.options.push(option);
    }
  };
}

function controller(log: Log) {
  const messages: { name: string; data: unknown }[] = [];
  Object.assign(globalThis, {
    window: {
      log,
      assets: null,
      selection: { getRenderTime: () => 1.5 },
      sendMainMessage: (name: string, data: unknown) => messages.push({ name, data })
    },
    document: { createElement: () => ({ value: "", text: "", textContent: "" }) }
  });
  const result: Field3dController = Object.create(Field3dController.prototype);
  Object.assign(result, {
    UUID: "test",
    sourceList: { getState: () => [], getActiveFields: () => ["/pose"], refresh: () => {}, setState: () => {} },
    URDF_SELECT: select(),
    JOINT_SELECT: select(),
    FIELD_SELECT: select("custom"),
    FIXED_FRAME_INPUT: { value: "" },
    PACKAGE_NAME: { textContent: "" },
    URDF_STATUS: { textContent: "" },
    urdfXML: null,
    urdfRobot: null,
    urdfModel: null,
    urdfError: null,
    urdfLoadError: null,
    packageRootUrl: null,
    meshBaseUrl: null,
    RESOURCE_NAME: { textContent: "" },
    urdfFile: null,
    packageRootReference: null,
    meshBaseReference: null,
    urdfTopics: null,
    urdfOptionsDirty: true,
    readEnvironment: () => ({ lengthMeters: 10, widthMeters: 10, originXMeters: 0, originYMeters: 0 }),
    writeEnvironment: () => {},
    updateFieldOptions: () => {},
    updateFieldDependentControls: () => {}
  });
  return { result, messages };
}

test("URDF options reuse discovered topics until fields refresh or the log changes", (t) => {
  const log = new Log();
  log.putString("/robot_description", 0, "<robot/>");
  log.createBlankField("/joint_states", LoggableType.Empty);
  log.setStructuredType("/joint_states", "sensor_msgs/msg/JointState");
  let scans = 0;
  const original = log.getFieldKeys.bind(log);
  t.mock.method(log, "getFieldKeys", () => {
    scans++;
    return original();
  });
  const { result } = controller(log);
  const update = () => (result as unknown as { updateURDFOptions(): void }).updateURDFOptions();
  update();
  update();
  update();
  assert.equal(scans, 1);
  const state = result as unknown as {
    URDF_SELECT: ReturnType<typeof select>;
    JOINT_SELECT: ReturnType<typeof select>;
  };
  assert.deepEqual(
    state.URDF_SELECT.options.map((option) => option.value),
    ["", "/robot_description"]
  );
  assert.deepEqual(
    state.JOINT_SELECT.options.map((option) => option.value),
    ["", "/joint_states"]
  );
  log.putString("/Live1/robot_description", 0, "<robot/>");
  result.refresh();
  update();
  assert.equal(scans, 2);
  assert.ok(state.URDF_SELECT.options.some((option) => option.value === "/Live1/robot_description"));
  window.log = new Log();
  update();
  assert.deepEqual(
    state.URDF_SELECT.options.map((option) => option.value),
    [""]
  );
});

test("None excludes URDF descriptions and JointState subscriptions", () => {
  const log = new Log();
  log.putString("/robot_description", 0, "<robot/>");
  log.createBlankField("/joint_states", LoggableType.Empty);
  log.setStructuredType("/joint_states", "sensor_msgs/msg/JointState");
  const { result } = controller(log);
  assert.ok(result.getActiveFields().includes("/pose"));
  assert.ok(!result.getActiveFields().includes("/robot_description"));
  assert.ok(!result.getActiveFields().includes("/joint_states"));
  Object.assign(result, { URDF_SELECT: select("/robot_description") });
  assert.ok(result.getActiveFields().includes("/robot_description"));
  assert.ok(result.getActiveFields().includes("/joint_states"));
});

test("layouts store local source references and reload them through the desktop boundary", () => {
  const { result, messages } = controller(new Log());
  Object.assign(result, {
    urdfFile: {
      xml: "<robot secret='content'/>",
      url: "file:///private/robot.urdf",
      name: "robot.urdf",
      reference: "robot-id"
    },
    packageRootUrl: "file:///private/packages/",
    meshBaseUrl: "file:///private/resources/",
    packageRootReference: "packages-id",
    meshBaseReference: "resources-id",
    URDF_SELECT: select("file")
  });
  const saved = result.saveState();
  const serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes("file:///"));
  assert.ok(!serialized.includes("<robot"));
  const restored = controller(window.log);
  restored.result.restoreState(saved);
  assert.deepEqual(
    restored.messages.map((message) => message.data),
    [
      { uuid: "test", kind: "robot", reference: "robot-id" },
      { uuid: "test", kind: "packages", reference: "packages-id" },
      { uuid: "test", kind: "resources", reference: "resources-id" }
    ]
  );
  assert.equal(messages.length, 0);
});

test("layout-supplied XML and file URLs never load or migrate local sources", () => {
  const { result, messages } = controller(new Log());
  result.restoreState({
    urdf: {
      file: { xml: "<robot/>", url: "file:///home/user/.ssh/id_rsa", name: "secret" },
      description: "file",
      joints: "/joint_states",
      packageRootUrl: "file:///private/packages/",
      meshBaseUrl: "file:///private/resources/"
    }
  });
  const state = result as unknown as {
    urdfFile: unknown;
    packageRootUrl: unknown;
    meshBaseUrl: unknown;
  };
  assert.equal(state.urdfFile, null);
  assert.equal(state.packageRootUrl, null);
  assert.equal(state.meshBaseUrl, null);
  assert.deepEqual(messages, []);
  assert.ok(!JSON.stringify(result.saveState()).includes("file:///"));
});

test("disposing a tab removes its URDF event listener before any later picked event", () => {
  const log = new Log();
  const target = Object.assign(new EventTarget(), { log });
  const nodes = new Map<string, { value: string; textContent: string; addEventListener(): void }>();
  const node = (key: string) => {
    if (!nodes.has(key)) nodes.set(key, { value: "", textContent: "", addEventListener() {} });
    return nodes.get(key)!;
  };
  const settings = {
    querySelector: node,
    getElementsByClassName: (key: string) => [node(key)]
  };
  let sourceStopped = false;
  const exports: {
    default?: new (root: unknown) => { UUID: string; dispose(): void };
  } = {};
  const script = ts.transpileModule(readFileSync("src/hub/controllers/Field3dController.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  runInNewContext(script, {
    exports,
    window: target,
    URL,
    require(name: string) {
      if (name === "../../shared/util") return { createUUID: () => "closed-tab" };
      if (name === "../../shared/CustomEnvironment") return { DEFAULT_CUSTOM_ENVIRONMENT: {} };
      if (name === "./TabController") return { setupKeyboardControls() {} };
      if (name === "../SourceList")
        return {
          __esModule: true,
          default: class {
            stop() {
              sourceStopped = true;
            }
          }
        };
      return {};
    }
  });
  Object.assign(exports.default!.prototype, { updateFieldOptions() {}, updateRobotOptions() {} });
  const tab = new exports.default!({ isConnected: true, getElementsByClassName: () => [settings] });
  assert.equal(getEventListeners(target, "urdf-picked").length, 1);
  const picked = (error: string) => Object.assign(new Event("urdf-picked"), { detail: { uuid: tab.UUID, error } });
  target.dispatchEvent(picked("Before close"));
  assert.equal(node(".urdf-status").textContent, "Before close");
  tab.dispose();
  assert.equal(getEventListeners(target, "urdf-picked").length, 0);
  target.dispatchEvent(picked("After close"));
  assert.equal(node(".urdf-status").textContent, "Before close");
  assert.equal(sourceStopped, true);
});

test("per-frame commands retain only the model id and source changes replace the separate resource", () => {
  const log = new Log();
  log.putString(
    "/robot_description",
    1,
    '<robot name="resource"><link name="base_link"><visual><geometry><box size="1 1 1"/></geometry></visual></link></robot>'
  );
  const { result } = controller(log);
  Object.assign(result, { URDF_SELECT: select("/robot_description") });
  const first = result.getCommand();
  const model = result.getURDFModel();
  assert(model);
  const object = first.objects.find((object) => object.type === "urdf");
  assert(object);
  assert.equal(object.modelId, model.id);
  assert.deepEqual(Object.keys(object).sort(), ["links", "modelId", "type"]);
  assert.ok(!JSON.stringify(first).includes("geometry"));
  assert.deepEqual(result.getCommand().objects, first.objects);
  assert.equal(result.getURDFModel(), model);
  Object.assign(result, { meshBaseUrl: "file:///picked/meshes/" });
  const changed = result.getCommand().objects.find((object) => object.type === "urdf");
  assert(changed);
  assert.notEqual(changed.modelId, model.id);
  assert.equal(result.getURDFModel()!.baseUrl, "file:///picked/meshes/");
  Object.assign(result, { URDF_SELECT: select() });
  assert.ok(!result.getCommand().objects.some((object) => object.type === "urdf"));
  assert.equal(result.getURDFModel(), null);
});
