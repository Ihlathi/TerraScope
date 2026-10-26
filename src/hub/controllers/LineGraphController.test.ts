// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import LineGraphFilter from "../../shared/LineGraphFilter";
import { SelectionMode } from "../../shared/Selection";
import { SourceListItemState, SourceListState } from "../../shared/SourceListConfig";
import Log from "../../shared/log/Log";
import LineGraphController from "./LineGraphController";
import { LineGraphController_DiscreteConfig, LineGraphController_NumericConfig } from "./LineGraphController_Config";
import { detectEnum, getNumericSourceUnit } from "./LineGraphFieldSemantics";

function source(logKey: string, type = "stepped", options: Record<string, string> = {}): SourceListItemState {
  return { logKey, type, logType: "Number", visible: true, options: { color: "#2b66a2", ...options } };
}

function sourceList() {
  let state: SourceListState = [];
  return {
    getState: () => state,
    setState: (next: SourceListState) => {
      state = next;
    },
    setTitle: (_title: string) => {}
  };
}

function controller(log: Log, range: [number, number] = [0, 5]): LineGraphController {
  Object.assign(globalThis, {
    window: {
      log,
      matchMedia: () => ({ matches: false }),
      selection: {
        getTimelineRange: () => range,
        getMode: () => SelectionMode.Idle,
        getSelectedTime: () => null,
        getHoveredTime: () => null,
        getGrabZoomRange: () => null
      }
    }
  });
  const result: LineGraphController = Object.create(LineGraphController.prototype);
  Object.assign(result, {
    RANGE_MARGIN: 0.05,
    MIN_AXIS_RANGE: 1e-5,
    MAX_AXIS_RANGE: 1e20,
    MAX_VALUE: 1e20,
    leftSourceList: sourceList(),
    rightSourceList: sourceList(),
    discreteSourceList: sourceList(),
    leftLockedRange: null,
    rightLockedRange: null,
    leftUnitConversion: { autoTarget: null, preset: null },
    rightUnitConversion: { autoTarget: null, preset: null },
    leftFilter: LineGraphFilter.None,
    rightFilter: LineGraphFilter.None,
    showRobotMode: false
  });
  return result;
}

test("detects bounded string and integer enum domains in first occurrence order", () => {
  assert.deepEqual(detectEnum(["idle", "running", "idle", "fault"]), { values: ["idle", "running", "fault"] });
  assert.deepEqual(detectEnum([2, -1, 2, 0]), { values: [2, -1, 0] });
  assert.deepEqual(detectEnum(["__proto__", "constructor"]), { values: ["__proto__", "constructor"] });
  for (const values of [
    [],
    [0.1, 0.2],
    [NaN],
    [Infinity],
    [true, false],
    [[1]],
    [1, "1"],
    Array.from({ length: 11 }, (_, i) => i)
  ]) {
    assert.equal(detectEnum(values), null);
  }
});

test("enum lanes preserve states over time and colors across zoom and layout reload", () => {
  for (const states of [
    ["idle", "running", "fault", "idle"],
    [0, 2, 3, 0]
  ]) {
    const log = new Log();
    states.forEach((value, index) =>
      typeof value === "string" ? log.putString("state", index, value) : log.putNumber("state", index, value)
    );
    const graph = controller(log);
    graph.restoreState({ discreteSources: [source("state", "enum")] });
    const full = graph.getCommand().discreteFields[0];
    assert.deepEqual(full.timestamps, [0, 1, 2, 3]);
    assert.deepEqual(full.values, states.map(String));
    assert.equal(full.type, "stripes");
    assert.equal(new Set(Object.values(full.colorMap!)).size, 3);
    const zoom = controller(log, [1.5, 2.5]);
    zoom.restoreState(JSON.parse(JSON.stringify(graph.saveState())));
    const clipped = zoom.getCommand().discreteFields[0];
    assert.deepEqual(clipped.timestamps, [1.5, 2]);
    assert.deepEqual(clipped.values, states.slice(1, 3).map(String));
    assert.deepEqual(clipped.colorMap, full.colorMap);
    assert.deepEqual(log.getRange("state", -Infinity, Infinity)?.timestamps, [0, 1, 2, 3]);
  }
});

test("enum lanes reuse unchanged field history and refresh after mutations", (t) => {
  for (const states of [
    ["idle", "running", "fault"],
    [2, -1, 0]
  ]) {
    const log = new Log();
    const put = (time: number, value: string | number) =>
      typeof value === "string" ? log.putString("state", time, value) : log.putNumber("state", time, value);
    put(0, states[0]);
    put(1, states[1]);
    const field = log.getField("state")!;
    const getRange = field.getRange.bind(field);
    let historyReads = 0;
    t.mock.method(field, "getRange", (...args: Parameters<typeof getRange>) => {
      if (args[0] === -Infinity && args[1] === Infinity) historyReads++;
      return getRange(...args);
    });
    const graph = controller(log);
    graph.restoreState({ discreteSources: [source("state", "enum")] });
    const first = graph.getCommand().discreteFields[0];
    assert.deepEqual(first.values, states.slice(0, 2).map(String));
    assert.deepEqual(Object.keys(first.colorMap!).sort(), states.slice(0, 2).map(String).sort());
    assert.equal(historyReads, 1);
    assert.deepEqual(graph.getCommand().discreteFields[0], first);
    assert.deepEqual(graph.getCommand().discreteFields[0], first);
    assert.equal(historyReads, 1);

    put(2, states[2]);
    const appended = graph.getCommand().discreteFields[0];
    assert.deepEqual(appended.values, states.map(String));
    assert.deepEqual(Object.keys(appended.colorMap!).sort(), states.map(String).sort());
    for (const value of states.slice(0, 2)) {
      assert.equal(appended.colorMap![String(value)], first.colorMap![String(value)]);
    }
    assert.equal(historyReads, 2);
    assert.deepEqual(graph.getCommand().discreteFields[0], appended);
    assert.equal(historyReads, 2);

    put(0, states[2]);
    const replaced = graph.getCommand().discreteFields[0];
    assert.deepEqual(replaced.values, [states[2], states[1], states[2]].map(String));
    assert.equal(replaced.colorMap![String(states[2])], first.colorMap![String(states[0])]);
    assert.equal(historyReads, 3);
    field.clearBeforeTime(2.5);
    const trimmed = graph.getCommand().discreteFields[0];
    assert.deepEqual(trimmed.values, [String(states[2])]);
    assert.deepEqual(Object.keys(trimmed.colorMap!), [String(states[2])]);
    assert.equal(historyReads, 4);
  }
});

test("invalid enum history is cached and refreshed when the field becomes valid", (t) => {
  const log = new Log();
  log.putNumber("state", 0, 0.25);
  const field = log.getField("state")!;
  const getRange = field.getRange.bind(field);
  let historyReads = 0;
  t.mock.method(field, "getRange", (...args: Parameters<typeof getRange>) => {
    if (args[0] === -Infinity && args[1] === Infinity) historyReads++;
    return getRange(...args);
  });
  const graph = controller(log);
  graph.restoreState({ discreteSources: [source("state", "enum")] });
  const first = graph.getCommand().discreteFields[0];
  assert.deepEqual(first.values, ["0.25"]);
  assert.equal(first.colorMap, undefined);
  assert.equal(historyReads, 1);
  assert.deepEqual(graph.getCommand().discreteFields[0], first);
  assert.equal(historyReads, 1);
  log.putNumber("state", 0, 2);
  const valid = graph.getCommand().discreteFields[0];
  assert.deepEqual(valid.values, ["2"]);
  assert.deepEqual(Object.keys(valid.colorMap!), ["2"]);
  assert.equal(historyReads, 2);

  const replacement = new Log();
  replacement.putString("state", 0, "ready");
  replacement.putString("state", 1, "waiting");
  assert.equal(replacement.getField("state")!.getRevision(), field.getRevision());
  window.log = replacement;
  const reloaded = graph.getCommand().discreteFields[0];
  assert.deepEqual(reloaded.values, ["ready", "waiting"]);
  assert.deepEqual(Object.keys(reloaded.colorMap!), ["ready", "waiting"]);
});

test("enum lane colors handle arbitrary state names and invalid enum fields retain visible values", () => {
  const log = new Log();
  log.putString("state", 0, "__proto__");
  log.putString("state", 1, "constructor");
  log.putNumber("continuous", 0, 0.25);
  log.putNumber("continuous", 1, 0.75);
  const graph = controller(log);
  graph.restoreState({ discreteSources: [source("state", "enum"), source("continuous", "enum")] });
  const [enumLane, fallback] = graph.getCommand().discreteFields;
  assert.deepEqual(enumLane.values, ["__proto__", "constructor"]);
  assert.equal(Object.hasOwn(enumLane.colorMap!, "__proto__"), true);
  assert.equal(typeof enumLane.colorMap!.constructor, "string");
  assert.deepEqual(fallback.values, ["0.25", "0.75"]);
  assert.equal(fallback.colorMap, undefined);
});

test("a declared source unit survives a saved layout and drives numeric conversion", () => {
  const log = new Log();
  log.putNumber("distance", 0, 1);
  log.putNumber("distance", 2, 2);
  assert.equal(log.getUnit("distance"), null);
  const graph = controller(log);
  graph.restoreState({
    leftSources: [source("distance", "stepped", { sourceUnit: "meters" })],
    leftUnitConversion: { autoTarget: "feet", preset: null }
  });
  const saved = JSON.parse(JSON.stringify(graph.saveState()));
  const restored = controller(log);
  restored.restoreState(saved);
  const command = restored.getCommand();
  assert.equal(command.leftFields[0].values.length, 2);
  assert.ok(Math.abs(command.leftFields[0].values[0] - 3.280839895) < 1e-9);
  assert.ok(Math.abs(command.leftFields[0].values[1] - 6.56167979) < 1e-9);
  assert.equal(command.leftUnits?.suffix, "ft");
  assert.deepEqual(restored.saveState(), saved);
  assert.equal(log.getUnit("distance"), null);
});

test("metadata units take precedence and absent or invalid declarations keep legacy numeric output", () => {
  const log = new Log();
  log.putNumber("distance", 0, 12);
  log.setMetadataString("distance", JSON.stringify({ unit: "inches" }));
  assert.equal(getNumericSourceUnit(log, source("distance", "stepped", { sourceUnit: "meters" })), "inches");
  const graph = controller(log);
  graph.restoreState({
    leftSources: [source("distance", "stepped", { sourceUnit: "meters" })],
    leftUnitConversion: { autoTarget: "feet", preset: null }
  });
  assert.ok(Math.abs(graph.getCommand().leftFields[0].values[0] - 1) < 1e-12);
  const noUnit = new Log();
  noUnit.putNumber("value", 0, 12);
  const declarations: Record<string, string>[] = [
    {},
    { sourceUnit: "invalid" },
    { sourceUnit: "__proto__" },
    { sourceUnit: "automatic" }
  ];
  for (const options of declarations) {
    const legacy = controller(noUnit);
    legacy.restoreState({ leftSources: [source("value", "stepped", options)] });
    assert.deepEqual(legacy.getCommand().leftFields[0].values, [12]);
    assert.equal(legacy.getCommand().leftUnits, null);
  }
});

test("legacy discrete and numeric source types retain their defaults and output", () => {
  assert.deepEqual(
    LineGraphController_DiscreteConfig.types.map((type) => type.key),
    ["stripes", "graph", "alerts", "enum"]
  );
  assert.deepEqual(
    LineGraphController_NumericConfig.types.map((type) => type.key),
    ["stepped", "smooth", "points"]
  );
  for (const type of LineGraphController_NumericConfig.types) {
    const unitOption = type.options.find((option) => option.key === "sourceUnit")!;
    assert.equal(unitOption.showInTypeName, false);
    assert.equal(unitOption.values[0].key, "automatic");
  }
  const log = new Log();
  log.putString("state", 0, "idle");
  log.putString("state", 1, "running");
  const graph = controller(log);
  graph.restoreState({ discreteSources: [source("state", "stripes")] });
  const lane = graph.getCommand().discreteFields[0];
  assert.deepEqual(lane.values, ['"idle"', '"running"']);
  assert.equal(lane.colorMap, undefined);
});
