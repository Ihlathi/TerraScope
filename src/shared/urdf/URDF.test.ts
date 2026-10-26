// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeFramePose } from "../log/FrameGraph";
import { jointPose, parseURDF, resolveURDFMesh, urdfEdges, type URDFJoint } from "./URDF";

function close(actual: readonly number[], expected: readonly number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < 1e-10, `${value} != ${expected[index]}`)
  );
}

const description = `<robot name="fixture">
  <material name="red"><color rgba="1 0 0 0.8"/></material>
  <link name="base"><visual><origin xyz="1 2 3" rpy="0 0 1.5707963267948966"/><geometry><box size="1 2 3"/></geometry><material name="red"/></visual></link>
  <link name="arm"><visual><geometry><cylinder radius="0.2" length="2"/></geometry></visual></link>
  <link name="slide"><visual><geometry><sphere radius="0.3"/></geometry></visual></link>
  <link name="tool"><visual><geometry><mesh filename="package://demo/mesh.stl" scale="1 2 3"/></geometry></visual></link>
  <joint name="hinge" type="revolute"><parent link="base"/><child link="arm"/><origin xyz="0 0 1"/><axis xyz="0 0 2"/><limit lower="-1" upper="1"/></joint>
  <joint name="slide_joint" type="prismatic"><parent link="arm"/><child link="slide"/><axis xyz="1 0 0"/><limit lower="0" upper="0.6"/></joint>
  <joint name="tool_joint" type="fixed"><parent link="slide"/><child link="tool"/><origin xyz="0 0 0.5"/></joint>
</robot>`;

test("parse visual primitives, mesh scale, materials, origins and a connected joint tree", () => {
  const robot = parseURDF(description);
  assert.equal(robot.name, "fixture");
  assert.deepEqual(robot.rootLinks, ["base"]);
  assert.deepEqual(
    robot.links.map((link) => link.visuals[0].geometry.type),
    ["box", "cylinder", "sphere", "mesh"]
  );
  assert.deepEqual(robot.links[0].visuals[0].color, [1, 0, 0, 0.8]);
  assert.deepEqual(robot.links[0].visuals[0].origin.translation, [1, 2, 3]);
  close(robot.links[0].visuals[0].origin.rotation, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  assert.deepEqual(robot.links[3].visuals[0].geometry, {
    type: "mesh",
    filename: "package://demo/mesh.stl",
    scale: [1, 2, 3]
  });
  const hinge = robot.joints[0];
  assert.equal(hinge.type, "revolute");
  assert.deepEqual(hinge.axis, [0, 0, 1]);
});

test("parse default joint axis, default visual origin and inline color", () => {
  const robot = parseURDF(
    `<robot name="defaults"><link name="a"/><link name="b"><visual><geometry><sphere radius="1"/></geometry><material><color rgba="0 1 0 1"/></material></visual></link><joint name="spin" type="continuous"><parent link="a"/><child link="b"/></joint></robot>`
  );
  assert.equal(robot.joints[0].type, "continuous");
  assert.deepEqual(robot.links[1].visuals[0].origin, { translation: [0, 0, 0], rotation: [1, 0, 0, 0] });
  assert.deepEqual(robot.links[1].visuals[0].color, [0, 1, 0, 1]);
  assert.deepEqual(
    jointPose(robot.joints[0], Math.PI).rotation.map((v) => Math.round(v)),
    [0, 1, 0, 0]
  );
});

test("reject malformed XML, unsupported geometry and invalid numeric values", () => {
  const invalid = [
    "<robot>",
    '<sdf name="wrong"/>',
    '<!DOCTYPE robot [<!ENTITY x "bad">]><robot name="bad"><link name="a"/></robot>',
    '<robot name="bad"><link name="a"><visual><geometry><cone radius="1"/></geometry></visual></link></robot>',
    description.replace('size="1 2 3"', 'size="1 nope 3"'),
    description.replace('radius="0.2"', 'radius="-1"'),
    description.replace('scale="1 2 3"', 'scale="1 0 3"'),
    description.replace('xyz="0 0 2"', 'xyz="0 0 0"'),
    description.replace('lower="-1" upper="1"', 'lower="2" upper="1"'),
    description.replace('rpy="0 0 1.5707963267948966"', 'rpy="0 0 Infinity"'),
    description.replace('<limit lower="-1" upper="1"/>', "")
  ];
  for (const xml of invalid) assert.throws(() => parseURDF(xml), /URDF/);
});

test("reject duplicate links, duplicate joints, missing references, cycles, multiple parents and disconnected trees", () => {
  const invalid = [
    description.replace('<link name="arm">', '<link name="base">'),
    description.replace('name="slide_joint"', 'name="hinge"'),
    description.replace('parent link="base"', 'parent link="missing"'),
    description.replace('parent link="base"', 'parent link="tool"'),
    description.replace('child link="slide"', 'child link="arm"'),
    description.replace("</robot>", '<link name="detached"/></robot>'),
    description.replace('type="revolute"', 'type="floating"'),
    description.replace('<axis xyz="0 0 2"/>', '<mimic joint="other"/>')
  ];
  for (const xml of invalid) assert.throws(() => parseURDF(xml), /URDF/);
});

const origin = {
  translation: [1, 2, 3] as [number, number, number],
  rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] as [number, number, number, number]
};
const base = { name: "test", parent: "a", child: "b", origin };

test("fixed joints preserve the static origin independently of a supplied position", () => {
  const fixed: URDFJoint = { ...base, type: "fixed" };
  assert.deepEqual(jointPose(fixed, 100), origin);
  assert.deepEqual(jointPose(fixed, -100), origin);
});

test("revolute joints compose local-axis rotation after origin and respect both limits", () => {
  const joint: URDFJoint = { ...base, type: "revolute", axis: [1, 0, 0], lower: -Math.PI / 2, upper: Math.PI / 2 };
  const pose = jointPose(joint, Math.PI / 2);
  close(pose.translation, [1, 2, 3]);
  close(pose.rotation, [0.5, 0.5, 0.5, 0.5]);
  close(jointPose(joint, 100).rotation, pose.rotation);
  close(jointPose(joint, -100).rotation, jointPose(joint, -Math.PI / 2).rotation);
});

test("continuous joints rotate beyond a full revolution without limits", () => {
  const joint: URDFJoint = { ...base, type: "continuous", axis: [0, 0, 1] };
  close(jointPose(joint, 5 * Math.PI).rotation, [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  close(jointPose(joint, -5 * Math.PI).rotation, [Math.SQRT1_2, 0, 0, -Math.SQRT1_2]);
});

test("prismatic joints translate in the rotated local axis and respect both limits", () => {
  const joint: URDFJoint = { ...base, type: "prismatic", axis: [1, 0, 0], lower: -0.5, upper: 1.5 };
  close(jointPose(joint, 1).translation, [1, 3, 3]);
  close(jointPose(joint, 100).translation, [1, 3.5, 3]);
  close(jointPose(joint, -100).translation, [1, 1.5, 3]);
  close(jointPose(joint, 1).rotation, origin.rotation);
});

test("joint names select positions, absent positions default to zero, and fixed links compose", () => {
  const robot = parseURDF(description);
  const edges = urdfEdges(
    robot,
    new Map([
      ["slide_joint", 0.4],
      ["hinge", Math.PI / 4],
      ["unrelated", 100]
    ])
  );
  let pose = composeFramePose(edges[0].pose, edges[1].pose);
  pose = composeFramePose(pose, edges[2].pose);
  close(pose.translation, [0.4 * Math.SQRT1_2, 0.4 * Math.SQRT1_2, 1.5]);
  const rest = urdfEdges(robot, new Map());
  assert.deepEqual(rest[1].pose.translation, [0, 0, 0]);
});

test("resolve relative STL and DAE files against the URDF file", () => {
  assert.deepEqual(resolveURDFMesh("../meshes/tool.STL", "file:///robots/demo/urdf/robot.urdf", null), {
    url: "file:///robots/demo/meshes/tool.STL"
  });
  assert.deepEqual(resolveURDFMesh("mesh.dae", "file:///robots/demo/robot.urdf", null), {
    url: "file:///robots/demo/mesh.dae"
  });
  assert.deepEqual(resolveURDFMesh("file:///robots/demo/tool.stl", null, null), {
    url: "file:///robots/demo/tool.stl"
  });
});

test("resolve package paths against a user-selected parent root and report every unresolved case", () => {
  assert.deepEqual(resolveURDFMesh("package://demo/meshes/arm.dae", null, "file:///robot%20packages"), {
    url: "file:///robot%20packages/demo/meshes/arm.dae"
  });
  for (const result of [
    resolveURDFMesh("package://demo/arm.stl", null, null),
    resolveURDFMesh("package://demo/../arm.stl", null, "file:///packages"),
    resolveURDFMesh("package://demo/%2e%2e/arm.stl", null, "file:///packages"),
    resolveURDFMesh("package://demo/%2F..%2Fother/arm.stl", null, "file:///packages"),
    resolveURDFMesh("relative.stl", null, null),
    resolveURDFMesh("https://example.com/arm.stl", null, null),
    resolveURDFMesh("mesh.obj", "file:///robots/demo/robot.urdf", null)
  ])
    assert.ok("error" in result, JSON.stringify(result));
});
