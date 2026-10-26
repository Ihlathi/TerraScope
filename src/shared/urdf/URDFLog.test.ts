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
import { parseURDF, urdfEdges } from "./URDF";
import {
  inURDFScope,
  jointStateTopics,
  readURDFJointPositions,
  urdfDescriptionTopics,
  valueAtURDFTime
} from "./URDFLog";

const fixture = path.join(process.cwd(), "src/hub/dataSources/ros2/fixtures/urdf/robot.db3");
function close(actual: number[], expected: number[]) {
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual} != ${expected}`));
}

test("fixture bag drives named joints, limits, and attached frame-id geometry at the cursor", async () => {
  const log = new Log(false);
  await new ROS2BagDecoder().decode(log, new Uint8Array(readFileSync(fixture)), () => {});
  assert.deepEqual(urdfDescriptionTopics(log), ["/robot_description"]);
  assert.deepEqual(jointStateTopics(log), ["/joint_states"]);
  const robot = parseURDF(valueAtURDFTime(log, "/robot_description/data", 1) as string);
  const graph = frameGraphForSource(log, "/scan");
  const first = readURDFJointPositions(log, jointStateTopics(log), 1.5);
  const second = readURDFJointPositions(log, jointStateTopics(log), 2.5);
  assert.equal(first.positions.get("shoulder"), 0);
  assert.equal(second.positions.get("shoulder"), 1);
  assert.equal(second.positions.get("slider"), 0.7);
  assert.equal(readURDFJointPositions(log, jointStateTopics(log), 0).positions.size, 0);
  assert.equal(readURDFJointPositions(log, jointStateTopics(log), 1.5).positions.get("slider"), 0);
  const edges = urdfEdges(robot, second.positions);
  assert.equal(graph.defaultFixedFrame(edges), "map");
  const frame = readSourceFrame(log, "/scan", 2.5)!;
  assert.equal(frame, "tool_link");
  const resolved = graph.resolve(frame, "map", 2.5, edges);
  assert.equal(resolved.status, "resolved");
  if (resolved.status !== "resolved") throw new Error("Fixture tool frame did not resolve");
  close(resolved.pose.translation, [2.1 * Math.cos(1), 2.1 * Math.sin(1), 0.7]);
  close(resolved.pose.rotation, [Math.cos(0.6), 0, 0, Math.sin(0.6)]);
  const limited = urdfEdges(robot, readURDFJointPositions(log, jointStateTopics(log), 3).positions);
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
