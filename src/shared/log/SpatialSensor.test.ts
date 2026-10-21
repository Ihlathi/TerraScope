// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import Log from "./Log";
import { SENSOR_POINT_LIMIT, laserScanPoints, pointCloudPoints, readSensorPoints } from "./SpatialSensor";

const scan = { angleMin: 0, angleIncrement: Math.PI / 2, rangeMin: 1, rangeMax: 4, ranges: [1, 2, 3, 4] };

function close(actual: number[], expected: number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${value} differs from ${expected[i]}`));
}

function cloud(options: { bigEndian?: boolean; float64?: boolean; padded?: boolean } = {}) {
  const bytes = options.float64 ? 8 : 4;
  const pointStep = bytes * 4;
  const rowStep = pointStep * 2 + (options.padded ? 9 : 0);
  const backing = new Uint8Array(rowStep * 2 + 11).fill(255);
  const data = backing.subarray(7, 7 + rowStep * 2);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const points = [
    [1, 2, 3],
    [-4, 5, 6],
    [7, -8, 9],
    [10, 11, 12]
  ];
  points.forEach((point, i) =>
    point.forEach((value, axis) => {
      const offset = Math.floor(i / 2) * rowStep + (i % 2) * pointStep + (axis + 1) * bytes;
      if (options.float64) view.setFloat64(offset, value, !options.bigEndian);
      else view.setFloat32(offset, value, !options.bigEndian);
    })
  );
  return {
    width: 2,
    height: 2,
    pointStep,
    rowStep,
    bigEndian: options.bigEndian ?? false,
    fields: [1, 2, 3].map((i) => ({ offset: bytes * i, datatype: options.float64 ? 8 : 7, count: 1 })),
    data
  };
}

test("converts laser bearings into XY points in meters", () => {
  close(laserScanPoints(scan), [1, 0, 0, 0, 2, 0, -3, 0, 0, 0, -4, 0]);
  close(
    laserScanPoints({ ...scan, angleMin: Math.PI / 2, angleIncrement: -Math.PI / 2, ranges: [1, 2] }),
    [0, 1, 0, 2, 0, 0]
  );
});

test("laser scans retain inclusive range limits and omit invalid returns", () => {
  close(
    laserScanPoints({ ...scan, angleIncrement: 0, ranges: [NaN, Infinity, -Infinity, 0.9, 4.1, 1, 4] }),
    [1, 0, 0, 4, 0, 0]
  );
  assert.deepEqual(laserScanPoints({ ...scan, ranges: [] }), []);
  assert.deepEqual(laserScanPoints({ ...scan, angleMin: NaN }), []);
  assert.deepEqual(laserScanPoints({ ...scan, rangeMax: 0 }), []);
});

test("point clouds honor offsets, organized row padding, byte offsets, scalar widths, and byte order", () => {
  for (const bigEndian of [false, true])
    for (const float64 of [false, true]) {
      close(pointCloudPoints(cloud({ bigEndian, float64, padded: true })), [1, 2, 3, -4, 5, 6, 7, -8, 9, 10, 11, 12]);
    }
});

test("point clouds omit nonfinite coordinates and reject incomplete or invalid layouts", () => {
  const sample = cloud();
  const view = new DataView(sample.data.buffer, sample.data.byteOffset, sample.data.byteLength);
  view.setFloat32(sample.fields[0].offset, NaN, true);
  view.setFloat32(sample.pointStep + sample.fields[2].offset, Infinity, true);
  close(pointCloudPoints(sample), [7, -8, 9, 10, 11, 12]);
  assert.deepEqual(pointCloudPoints({ ...sample, data: sample.data.slice(0, 4) }), []);
  assert.deepEqual(pointCloudPoints({ ...sample, rowStep: 1 }), []);
  assert.deepEqual(pointCloudPoints({ ...sample, width: 2.5 }), []);
  assert.deepEqual(pointCloudPoints({ ...sample, fields: [] }), []);
  assert.deepEqual(
    pointCloudPoints({ ...sample, fields: [{ offset: 0, datatype: 0, count: 1 }, ...sample.fields.slice(1)] }),
    []
  );
  assert.deepEqual(
    pointCloudPoints({
      ...sample,
      fields: [{ offset: sample.pointStep, datatype: 7, count: 1 }, ...sample.fields.slice(1)]
    }),
    []
  );
  assert.deepEqual(pointCloudPoints({ ...sample, width: 0, data: new Uint8Array() }), []);
});

test("fixed-stride downsampling bounds scan and cloud points without changing bearings", () => {
  const count = SENSOR_POINT_LIMIT + 1;
  const points = laserScanPoints({ ...scan, angleIncrement: 0.0001, ranges: new Array(count).fill(2) });
  assert.equal(points.length / 3, Math.ceil(count / 2));
  close(points.slice(3, 6), [2 * Math.cos(0.0002), 2 * Math.sin(0.0002), 0]);
  const data = new Uint8Array(count * 12);
  const view = new DataView(data.buffer);
  for (let i = 0; i < count; i++) view.setFloat32(i * 12, i, true);
  const result = pointCloudPoints({
    width: count,
    height: 1,
    pointStep: 12,
    rowStep: data.length,
    bigEndian: false,
    fields: [0, 4, 8].map((offset) => ({ offset, datatype: 7, count: 1 })),
    data
  });
  assert.equal(result.length / 3, Math.ceil(count / 2));
  assert.deepEqual(result.slice(0, 9), [0, 0, 0, 2, 0, 0, 4, 0, 0]);
});

function writeScan(log: Log, time: number, ranges: number[]) {
  log.putRaw("/scan", time, new Uint8Array([time]));
  log.setStructuredType("/scan", "sensor_msgs/msg/LaserScan");
  log.putUnknownStruct("/scan", time, { angle_min: 0, angle_increment: 0, range_min: 1, range_max: 4, ranges });
}

test("cursor reads select one complete scan, clear empty samples, and never select a future sample", () => {
  const log = new Log(false);
  writeScan(log, 1, []);
  writeScan(log, 2, [2]);
  writeScan(log, 3, [3, 4]);
  writeScan(log, 4, []);
  assert.deepEqual(readSensorPoints(log, "/scan", 0.5), []);
  assert.deepEqual(readSensorPoints(log, "/scan", 1.5), []);
  assert.deepEqual(readSensorPoints(log, "/scan", 2.5), [2, 0, 0]);
  assert.deepEqual(readSensorPoints(log, "/scan", 3), [3, 0, 0, 4, 0, 0]);
  assert.deepEqual(readSensorPoints(log, "/scan", 4), []);
});

test("cloud reads find named axes and use the current field descriptor count", () => {
  const log = new Log(false);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  [3, 1, 2].forEach((v, i) => view.setFloat32(i * 4, v, true));
  const message = {
    width: 1,
    height: 1,
    point_step: 12,
    row_step: 12,
    is_bigendian: false,
    data,
    fields: ["z", "x", "y"].map((name, i) => ({ name, offset: i * 4, datatype: 7, count: 1 }))
  };
  log.putRaw("/cloud", 1, new Uint8Array([1]));
  log.setStructuredType("/cloud", "sensor_msgs/msg/PointCloud2");
  log.putUnknownStruct("/cloud", 1, message);
  log.putRaw("/cloud", 2, new Uint8Array([2]));
  log.putUnknownStruct("/cloud", 2, { ...message, fields: message.fields.slice(0, 2) });
  assert.deepEqual(readSensorPoints(log, "/cloud", 0), []);
  assert.deepEqual(readSensorPoints(log, "/cloud", 1.5), [1, 2, 3]);
  assert.deepEqual(readSensorPoints(log, "/cloud", 2), []);
});
