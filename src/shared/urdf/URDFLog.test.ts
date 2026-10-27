// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ROS2BagDecoder from "../../hub/dataSources/ros2/ROS2BagDecoder";
import { frameGraphForSource, readSourceFrame } from "../log/FrameGraph";
import Log from "../log/Log";
import LogField from "../log/LogField";
import LoggableType from "../log/LoggableType";
import { sourceClock } from "../log/ProjectedLogField";
import { parseURDF, urdfEdges } from "./URDF";
import { discoverURDFTopics, inURDFScope, readURDFJointPositions, valueAtURDFTime } from "./URDFLog";

const fixture = path.join(process.cwd(), "src/hub/dataSources/ros2/fixtures/urdf/robot.db3");
function close(actual: number[], expected: number[]) {
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} != ${expected}`));
}

test("fixture bag drives named joints, limits, and attached frame-id geometry at the cursor", async () => {
  const log = new Log(false);
  await new ROS2BagDecoder().decode(log, new Uint8Array(readFileSync(fixture)), () => {});
  const topics = discoverURDFTopics(log);
  assert.deepEqual(topics.descriptions, ["/robot_description"]);
  assert.deepEqual(topics.joints, ["/joint_states"]);
  const robot = parseURDF(valueAtURDFTime(log, "/robot_description/data", 1) as string);
  const graph = frameGraphForSource(log, "/scan");
  const first = readURDFJointPositions(log, topics.joints, 1.5);
  const second = readURDFJointPositions(log, topics.joints, 2.5);
  assert.equal(first.positions.get("shoulder"), 0);
  assert.equal(second.positions.get("shoulder"), 1);
  assert.equal(second.positions.get("slider"), 0.7);
  assert.equal(readURDFJointPositions(log, topics.joints, 0).positions.size, 0);
  assert.equal(readURDFJointPositions(log, topics.joints, 1.5).positions.get("slider"), 0);
  const edges = urdfEdges(robot, second.positions);
  assert.equal(graph.defaultFixedFrame(edges), "map");
  const frame = readSourceFrame(log, "/scan", 2.5)!;
  assert.equal(frame, "tool_link");
  const resolved = graph.resolve(frame, "map", 2.5, edges);
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") throw new Error("Fixture tool frame did not resolve");
  close(resolved.pose.translation, [2.1 * Math.cos(1), 2.1 * Math.sin(1), 0.7]);
  close(resolved.pose.rotation, [Math.cos(0.6), 0, 0, Math.sin(0.6)]);
  const limited = urdfEdges(robot, readURDFJointPositions(log, topics.joints, 3).positions);
  const slider = limited.find((edge) => edge.child === "carriage_link")!;
  const shoulder = limited.find((edge) => edge.child === "arm_link")!;
  close(shoulder.pose.rotation, [Math.cos(0.6), 0, 0, Math.sin(0.6)]);
  close(slider.pose.translation, [1.2, 0, 0]);
  const before = graph.resolve(frame, "map", 1.5, urdfEdges(robot, first.positions));
  assert.equal(before.status, "resolved");
  if (before.status === "resolved") {
    close(before.pose.translation, [1.4, 0, 0.7]);
    close(before.pose.rotation, [Math.cos(0.1), 0, 0, Math.sin(0.1)]);
  }
});

test("logged TF owns matching child edges including before its first sample", () => {
  const log = new Log(false);
  log.putRaw("/tf", 2, new Uint8Array([2]));
  log.setStructuredType("/tf", "tf2_msgs/msg/TFMessage");
  log.putUnknownStruct("/tf", 2, {
    transforms: [
      {
        header: { frame_id: "base" },
        child_frame_id: "arm",
        transform: { translation: { x: 9, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } }
      }
    ]
  });
  const edges = [
    {
      parent: "base",
      child: "arm",
      pose: { translation: [1, 0, 0], rotation: [1, 0, 0, 0] } as import("../geometry").Pose3d
    }
  ];
  const graph = frameGraphForSource(log, "/scan");
  assert.deepEqual(graph.resolve("arm", "base", 1, edges), { status: "unavailable", frame: "arm" });
  const result = graph.resolve("arm", "base", 2, edges);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.deepEqual(result.pose.translation, [9, 0, 0]);
});

test("JointState samples retain partial joint updates and observe same-time corrections", () => {
  const log = new Log(false);
  const sample = (time: number, name: string[], position: number[]) => {
    log.putRaw("/joint_states", time, new Uint8Array([time, ...position]));
    log.setStructuredType("/joint_states", "sensor_msgs/msg/JointState");
    log.putStringArray("/joint_states/name", time, name);
    log.putNumberArray("/joint_states/position", time, position);
  };
  sample(1, ["a", "b"], [1, 2]);
  sample(2, ["a"], [3]);
  assert.deepEqual(
    [...readURDFJointPositions(log, ["/joint_states"], 2).positions],
    [
      ["a", 3],
      ["b", 2]
    ]
  );
  sample(2, ["a"], [4]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 2).positions.get("a"), 4);
  sample(3, ["a"], [NaN]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 3).positions.get("a"), 4);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 3).diagnostics.length, 1);
});

test("URDF edges stay in the selected recording and topic namespace", () => {
  assert.equal(inURDFScope("/Log0/robot/scan", "/Log0/robot"), true);
  assert.equal(inURDFScope("/Log1/robot/scan", "/Log0/robot"), false);
  assert.equal(inURDFScope("/Log0/other/scan", "/Log0/robot"), false);
  assert.equal(inURDFScope("/Live1/scan", ""), false);
  assert.equal(inURDFScope("/scan", ""), true);
});

test("automatic fixed frame ignores shadowed URDF parents", () => {
  const log = new Log(false);
  log.putRaw("/tf_static", 1, new Uint8Array([1]));
  log.setStructuredType("/tf_static", "tf2_msgs/msg/TFMessage");
  log.putUnknownStruct("/tf_static", 1, {
    transforms: [
      {
        header: { frame_id: "tracking_origin" },
        child_frame_id: "arm",
        transform: { translation: { x: 9, y: 0, z: 0 }, rotation: { w: 1, x: 0, y: 0, z: 0 } }
      }
    ]
  });
  const edges = [
    {
      parent: "base",
      child: "arm",
      pose: { translation: [1, 0, 0], rotation: [1, 0, 0, 0] } as import("../geometry").Pose3d
    }
  ];
  assert.equal(frameGraphForSource(log, "/scan").defaultFixedFrame(edges), "tracking_origin");
});

test("appended JointState revisions do not read or process earlier samples", () => {
  const log = new Log(false);
  const sample = (time: number) => {
    log.putRaw("/joint_states", time, new Uint8Array([time]));
    log.putStringArray("/joint_states/name", time, ["a"]);
    log.putNumberArray("/joint_states/position", time, [time]);
  };
  sample(1);
  sample(2);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 2).positions.get("a"), 2);
  const reads: { key: string; start: number }[] = [];
  const getRange = log.getRange.bind(log);
  log.getRange = (key, start, ...rest) => {
    reads.push({ key, start });
    return getRange(key, start, ...rest);
  };
  for (let time = 3; time <= 200; time++) sample(time);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 200).positions.get("a"), 200);
  assert.ok(reads.length > 0);
  assert.ok(
    reads.every((read) => read.start >= 3),
    JSON.stringify(reads)
  );
  reads.length = 0;
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 1).positions.get("a"), 1);
  assert.equal(reads.length, 0);
});

test("JointState caches observe earlier corrections, late fields, and live trimming", () => {
  const log = new Log(false);
  for (const time of [1, 2, 3]) {
    log.putRaw("/joint_states", time, new Uint8Array([time]));
    log.putStringArray("/joint_states/name", time, ["a"]);
    log.putNumberArray("/joint_states/position", time, [time]);
  }
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 1).positions.get("a"), 1);
  log.putNumberArray("/joint_states/position", 1, [9]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 1).positions.get("a"), 9);
  for (const key of ["/joint_states", "/joint_states/name", "/joint_states/position"]) {
    log.getField(key)!.clearBeforeTime(2.5);
  }
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 1).positions.size, 0);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 2.5).positions.get("a"), 2);
  log.putRaw("/joint_states", 4, new Uint8Array([4]));
  readURDFJointPositions(log, ["/joint_states"], 4);
  log.putStringArray("/joint_states/name", 4, ["b"]);
  log.putNumberArray("/joint_states/position", 4, [8]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 4).positions.get("b"), 8);
});

test("replacing JointState field identity invalidates cached samples", () => {
  const log = new Log(false);
  log.putRaw("/joint_states", 1, new Uint8Array([1]));
  log.putStringArray("/joint_states/name", 1, ["a"]);
  log.putNumberArray("/joint_states/position", 1, [1]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 1).positions.get("a"), 1);
  const field = new LogField(LoggableType.NumberArray);
  field.putNumberArray(1, [8]);
  log.setField("/joint_states/position", field);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 1).positions.get("a"), 8);
});

test("late appended child values update following JointState samples without inventing parent samples", () => {
  const log = new Log(false);
  log.putRaw("/joint_states", 1, new Uint8Array([1]));
  log.putRaw("/joint_states", 3, new Uint8Array([3]));
  log.putStringArray("/joint_states/name", 1, ["a"]);
  log.putNumberArray("/joint_states/position", 1, [1]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 3).positions.get("a"), 1);
  log.putNumberArray("/joint_states/position", 2, [8]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 3).positions.get("a"), 8);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 2).positions.get("a"), 1);
  log.putNumberArray("/joint_states/position", 4, [9]);
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 4).positions.get("a"), 8);
  log.putRaw("/joint_states", 5, new Uint8Array([5]));
  assert.equal(readURDFJointPositions(log, ["/joint_states"], 5).positions.get("a"), 9);
});

test("projected live JointStates append without rescanning and retain correction and clock invalidation", () => {
  const source = new Log(false);
  const display = new Log(false);
  const topic = "/Live1/joint_states";
  const sample = (time: number, position = time) => {
    source.putRaw("/joint_states", time, new Uint8Array([time]));
    source.putStringArray("/joint_states/name", time, ["a"]);
    source.putNumberArray("/joint_states/position", time, [position]);
  };
  const project = (offsetSeconds = 10) =>
    display.setProjectedSources([
      {
        log: source,
        namespace: "/Live1",
        conversion: {
          from: sourceClock("/Live1", source.getDisplayClock()),
          to: display.getDisplayClock(),
          offsetSeconds
        }
      }
    ]);
  sample(1);
  sample(2);
  project();
  assert.equal(readURDFJointPositions(display, [topic], 12).positions.get("a"), 2);
  for (const key of ["/joint_states", "/joint_states/name", "/joint_states/position"]) {
    source.getField(key)!.getTimestamps = () => {
      throw new Error("Scanned full source timestamps");
    };
  }
  const reads: number[] = [];
  const getRange = display.getRange.bind(display);
  display.getRange = (key, start, ...rest) => {
    reads.push(start);
    return getRange(key, start, ...rest);
  };
  sample(3);
  project();
  assert.equal(readURDFJointPositions(display, [topic], 13).positions.get("a"), 3);
  assert.ok(reads.length > 0);
  assert.ok(
    reads.every((start) => start >= 13),
    JSON.stringify(reads)
  );
  sample(1, 8);
  project();
  assert.equal(readURDFJointPositions(display, [topic], 11).positions.get("a"), 8);
  for (const key of ["/joint_states", "/joint_states/name", "/joint_states/position"]) {
    source.getField(key)!.clearBeforeTime(2.5);
  }
  project();
  assert.equal(readURDFJointPositions(display, [topic], 11).positions.size, 0);
  assert.equal(readURDFJointPositions(display, [topic], 12.5).positions.get("a"), 2);
  project(20);
  assert.equal(readURDFJointPositions(display, [topic], 12.5).positions.size, 0);
  assert.equal(readURDFJointPositions(display, [topic], 22.5).positions.get("a"), 2);
});

test("live no-op discards keep revisions and trimming followed by append reads only the boundary and suffix", () => {
  const log = new Log(false);
  const keys = ["/joint_states", "/joint_states/name", "/joint_states/position"];
  const sample = (time: number, name = "a", position = time) => {
    log.putRaw(keys[0], time, new Uint8Array([time]));
    log.putStringArray(keys[1], time, [name]);
    log.putNumberArray(keys[2], time, [position]);
  };
  sample(1);
  sample(2);
  sample(3);
  assert.equal(readURDFJointPositions(log, [keys[0]], 3).positions.get("a"), 3);
  const revisions = keys.map((key) => log.getField(key)!.getRevision());
  for (let i = 0; i < 120; i++) keys.forEach((key) => log.getField(key)!.clearBeforeTime(1));
  assert.deepEqual(
    keys.map((key) => log.getField(key)!.getRevision()),
    revisions
  );
  const reads: { key: string; start: number }[] = [];
  const getRange = log.getRange.bind(log);
  log.getRange = (key, start, ...rest) => {
    reads.push({ key, start });
    return getRange(key, start, ...rest);
  };
  assert.equal(readURDFJointPositions(log, [keys[0]], 3).positions.get("a"), 3);
  assert.equal(reads.length, 0);
  keys.forEach((key) => log.getField(key)!.clearBeforeTime(2.5));
  sample(4);
  assert.equal(readURDFJointPositions(log, [keys[0]], 2.5).positions.get("a"), 2);
  assert.equal(readURDFJointPositions(log, [keys[0]], 4).positions.get("a"), 4);
  assert.ok(reads.length > 0);
  assert.ok(
    reads.every((read) => read.start >= 2.5),
    JSON.stringify(reads)
  );
  assert.deepEqual(
    reads.filter((read) => read.key === keys[0]).map((read) => read.start),
    [4]
  );
});

test("trimming retains held partial joint positions despite compressed child histories", () => {
  const log = new Log(false);
  const keys = ["/joint_states", "/joint_states/name", "/joint_states/position"];
  const sample = (time: number, name: string, position: number) => {
    log.putRaw(keys[0], time, new Uint8Array([time]));
    log.putStringArray(keys[1], time, [name]);
    log.putNumberArray(keys[2], time, [position]);
  };
  sample(1, "a", 10);
  sample(2, "b", 20);
  sample(3, "b", 20);
  assert.equal(log.getField(keys[1])!.getTimestampCount(), 2);
  assert.equal(log.getField(keys[2])!.getTimestampCount(), 2);
  assert.deepEqual(
    [...readURDFJointPositions(log, [keys[0]], 3).positions],
    [
      ["a", 10],
      ["b", 20]
    ]
  );
  keys.forEach((key) => log.getField(key)!.clearBeforeTime(2.5));
  sample(4, "b", 30);
  const getRange = log.getRange.bind(log);
  log.getRange = (key, start, ...rest) => {
    assert.notEqual(start, -Infinity, "trimming cannot rebuild the retained history");
    return getRange(key, start, ...rest);
  };
  assert.equal(readURDFJointPositions(log, [keys[0]], 2).positions.size, 0);
  assert.deepEqual(
    [...readURDFJointPositions(log, [keys[0]], 2.5).positions],
    [
      ["a", 10],
      ["b", 20]
    ]
  );
  assert.deepEqual(
    [...readURDFJointPositions(log, [keys[0]], 4).positions],
    [
      ["a", 10],
      ["b", 30]
    ]
  );
});

test("JointState diagnostics stop at the cursor and summarize a bounded recent set", () => {
  const log = new Log(false);
  for (let time = 1; time <= 100; time++) {
    log.putRaw("/joint_states", time, new Uint8Array([time]));
    log.putStringArray("/joint_states/name", time, ["a"]);
    log.putNumberArray("/joint_states/position", time, [NaN]);
  }
  assert.deepEqual(readURDFJointPositions(log, ["/joint_states"], 0).diagnostics, []);
  const early = readURDFJointPositions(log, ["/joint_states"], 2).diagnostics;
  assert.equal(early.length, 2);
  assert.ok(early.every((message) => /at [12]\./.test(message)));
  const later = readURDFJointPositions(log, ["/joint_states"], 50).diagnostics;
  assert.equal(later.length, 6);
  assert.match(later[0], /at 46\./);
  assert.match(later[4], /at 50\./);
  assert.match(later[5], /45 earlier invalid/);
  assert.deepEqual(readURDFJointPositions(log, ["/joint_states"], 0).diagnostics, []);
});

test("projected live trimming and appending do not rebuild retained JointState history", () => {
  const source = new Log(false);
  const display = new Log(false);
  const sample = (time: number) => {
    source.putRaw("/joint_states", time, new Uint8Array([time]));
    source.putStringArray("/joint_states/name", time, ["a"]);
    source.putNumberArray("/joint_states/position", time, [time]);
  };
  const project = () =>
    display.setProjectedSources([
      {
        log: source,
        namespace: "/Live1",
        conversion: {
          from: sourceClock("/Live1", source.getDisplayClock()),
          to: display.getDisplayClock(),
          offsetSeconds: 10
        }
      }
    ]);
  for (const time of [1, 2, 3]) sample(time);
  project();
  assert.equal(readURDFJointPositions(display, ["/Live1/joint_states"], 13).positions.get("a"), 3);
  for (const key of ["/joint_states", "/joint_states/name", "/joint_states/position"])
    source.getField(key)!.clearBeforeTime(2.5);
  sample(4);
  project();
  const starts: number[] = [];
  const getRange = display.getRange.bind(display);
  display.getRange = (key, start, ...rest) => {
    starts.push(start);
    return getRange(key, start, ...rest);
  };
  assert.equal(readURDFJointPositions(display, ["/Live1/joint_states"], 12.5).positions.get("a"), 2);
  assert.equal(readURDFJointPositions(display, ["/Live1/joint_states"], 14).positions.get("a"), 4);
  assert.ok(starts.length > 0);
  assert.ok(
    starts.every((start) => start >= 12.5),
    JSON.stringify(starts)
  );
});
