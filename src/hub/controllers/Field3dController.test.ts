// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
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
    window: { log, sendMainMessage: (name: string, data: unknown) => messages.push({ name, data }) },
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

test("legacy layouts still load embedded XML and migrate their source URLs", () => {
  const { result, messages } = controller(new Log());
  result.restoreState({
    urdf: {
      file: { xml: "<robot/>", url: "file:///old/robot.urdf", name: "robot.urdf" },
      description: "file",
      joints: "/joint_states",
      packageRootUrl: "file:///old/packages/",
      meshBaseUrl: "file:///old/resources/"
    }
  });
  const state = result as unknown as { urdfFile: { xml: string }; URDF_SELECT: { value: string } };
  assert.equal(state.urdfFile.xml, "<robot/>");
  assert.equal(state.URDF_SELECT.value, "file");
  assert.deepEqual(
    messages.map((message) => message.data),
    [
      { uuid: "test", kind: "robot", url: "file:///old/robot.urdf" },
      { uuid: "test", kind: "packages", url: "file:///old/packages/" },
      { uuid: "test", kind: "resources", url: "file:///old/resources/" }
    ]
  );
});
