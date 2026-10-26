// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SemanticType, canReadAsPose, classifyStructuredType, structuredTypesFor } from "./SemanticType.ts";

test("maps WPILib geometry structs onto semantic kinds", () => {
  assert.equal(classifyStructuredType("Pose2d"), SemanticType.Pose2d);
  assert.equal(classifyStructuredType("Pose2d[]"), SemanticType.Pose2d);
  assert.equal(classifyStructuredType("Transform2d"), SemanticType.Pose2d);
  assert.equal(classifyStructuredType("Transform2d[]"), SemanticType.Pose2d);
  assert.equal(classifyStructuredType("Pose3d"), SemanticType.Pose3d);
  assert.equal(classifyStructuredType("Pose3d[]"), SemanticType.Pose3d);
  assert.equal(classifyStructuredType("Transform3d"), SemanticType.Pose3d);
  assert.equal(classifyStructuredType("Transform3d[]"), SemanticType.Pose3d);
  assert.equal(classifyStructuredType("Translation2d"), SemanticType.Translation);
  assert.equal(classifyStructuredType("Translation3d[]"), SemanticType.Translation);
  assert.equal(classifyStructuredType("Rotation2d"), SemanticType.Rotation);
  assert.equal(classifyStructuredType("Rotation3d[]"), SemanticType.Rotation);
  assert.equal(classifyStructuredType("Number"), SemanticType.NumericSeries);
});

test("maps AdvantageKit mechanism and Choreo trajectory structs", () => {
  assert.equal(classifyStructuredType("Mechanism2d"), SemanticType.MechanismJoint);
  assert.equal(classifyStructuredType("Trajectory"), SemanticType.Trajectory);
  assert.equal(classifyStructuredType("DifferentialSample[]"), SemanticType.Trajectory);
  assert.equal(classifyStructuredType("SwerveSample[]"), SemanticType.Trajectory);
});

test("returns null for unmapped types", () => {
  assert.equal(classifyStructuredType("SwerveModuleState[]"), null);
  assert.equal(classifyStructuredType("ChassisSpeeds"), null);
  assert.equal(classifyStructuredType(""), null);
  assert.equal(classifyStructuredType("Pose2d "), null);
});

test("pose source lists stay the field-tab sets", () => {
  assert.deepEqual(structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d]), [
    "Pose2d",
    "Pose3d",
    "Pose2d[]",
    "Pose3d[]",
    "Transform2d",
    "Transform3d",
    "Transform2d[]",
    "Transform3d[]"
  ]);
  assert.deepEqual(structuredTypesFor([SemanticType.Pose3d]), ["Pose3d", "Pose3d[]", "Transform3d", "Transform3d[]"]);
  assert.deepEqual(structuredTypesFor([SemanticType.Pose3d], { shape: "scalar" }), ["Pose3d", "Transform3d"]);
  assert.deepEqual(structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d, SemanticType.Translation]), [
    "Pose2d",
    "Pose3d",
    "Pose2d[]",
    "Pose3d[]",
    "Transform2d",
    "Transform3d",
    "Transform2d[]",
    "Transform3d[]",
    "Translation2d",
    "Translation3d",
    "Translation2d[]",
    "Translation3d[]"
  ]);
});

test("trajectory, rotation, mechanism, and numeric lists", () => {
  assert.deepEqual(
    [
      ...structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d, SemanticType.Translation], { shape: "array" }),
      ...structuredTypesFor([SemanticType.Trajectory])
    ],
    [
      "Pose2d[]",
      "Pose3d[]",
      "Transform2d[]",
      "Transform3d[]",
      "Translation2d[]",
      "Translation3d[]",
      "Trajectory",
      "DifferentialSample[]",
      "SwerveSample[]"
    ]
  );
  assert.deepEqual(
    structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d, SemanticType.Trajectory], {
      trajectorySamples: false
    }),
    [
      "Pose2d",
      "Pose3d",
      "Pose2d[]",
      "Pose3d[]",
      "Transform2d",
      "Transform3d",
      "Transform2d[]",
      "Transform3d[]",
      "Trajectory"
    ]
  );
  assert.deepEqual(structuredTypesFor([SemanticType.Rotation], { shape: "scalar" }), ["Rotation2d", "Rotation3d"]);
  assert.deepEqual(structuredTypesFor([SemanticType.MechanismJoint]), ["Mechanism2d"]);
  assert.deepEqual(structuredTypesFor([SemanticType.NumericSeries]), ["Number"]);
  assert.deepEqual(structuredTypesFor([SemanticType.Pose3d, SemanticType.Translation], { dimension: 3 }), [
    "Pose3d",
    "Pose3d[]",
    "Transform3d",
    "Transform3d[]",
    "Translation3d",
    "Translation3d[]"
  ]);
  assert.deepEqual(structuredTypesFor([SemanticType.Pose3d, SemanticType.Trajectory], { trajectorySamples: false }), [
    "Pose3d",
    "Pose3d[]",
    "Transform3d",
    "Transform3d[]",
    "Trajectory"
  ]);
  assert.deepEqual(
    [...structuredTypesFor([SemanticType.Pose3d]), ...structuredTypesFor([SemanticType.Translation], { dimension: 3 })],
    ["Pose3d", "Pose3d[]", "Transform3d", "Transform3d[]", "Translation3d", "Translation3d[]"]
  );
});

test("pose reader accepts mapped spatial types and rejects mechanism joints", () => {
  assert.equal(canReadAsPose("Pose2d"), true);
  assert.equal(canReadAsPose("Number"), true);
  assert.equal(canReadAsPose("SwerveSample[]"), true);
  assert.equal(canReadAsPose("TargetCorner:16f6ac0dedc8eaccb951f4895d9e18b6[]"), true);
  assert.equal(canReadAsPose("Mechanism2d"), false);
  assert.equal(canReadAsPose("ChassisSpeeds"), false);
});

test("maps ROS laser scans and point clouds without admitting them to pose readers", () => {
  for (const name of ["sensor_msgs/msg/LaserScan", "sensor_msgs/LaserScan"]) {
    assert.equal(classifyStructuredType(name), SemanticType.LaserScan);
    assert.equal(canReadAsPose(name), false);
  }
  for (const name of ["sensor_msgs/msg/PointCloud2", "sensor_msgs/PointCloud2"]) {
    assert.equal(classifyStructuredType(name), SemanticType.PointCloud);
    assert.equal(canReadAsPose(name), false);
  }
  assert.deepEqual(structuredTypesFor([SemanticType.LaserScan]), [
    "sensor_msgs/msg/LaserScan",
    "sensor_msgs/LaserScan"
  ]);
  assert.deepEqual(structuredTypesFor([SemanticType.PointCloud]), [
    "sensor_msgs/msg/PointCloud2",
    "sensor_msgs/PointCloud2"
  ]);
});

test("maps ROS image types without admitting them to pose readers", () => {
  for (const [name, semantic] of [
    ["Image", SemanticType.Image],
    ["CompressedImage", SemanticType.CompressedImage]
  ] as const) {
    const names = [`sensor_msgs/msg/${name}`, `sensor_msgs/${name}`];
    assert.deepEqual(structuredTypesFor([semantic]), names);
    for (const type of names) {
      assert.equal(classifyStructuredType(type), semantic);
      assert.equal(canReadAsPose(type), false);
    }
  }
});
