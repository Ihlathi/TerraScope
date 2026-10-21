// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "./Log";
import { SemanticType, classifyStructuredType } from "./SemanticType";

export const SENSOR_POINT_LIMIT = 20000;

type LaserScan = {
  angleMin: number;
  angleIncrement: number;
  rangeMin: number;
  rangeMax: number;
  ranges: number[];
};

type PointField = { offset: number; datatype: number; count: number };
type PointCloud = {
  width: number;
  height: number;
  pointStep: number;
  rowStep: number;
  bigEndian: boolean;
  fields: PointField[];
  data: Uint8Array;
};

const FIELD_READERS = [
  null,
  { bytes: 1, read: (view: DataView, offset: number, _little: boolean) => view.getInt8(offset) },
  { bytes: 1, read: (view: DataView, offset: number, _little: boolean) => view.getUint8(offset) },
  { bytes: 2, read: (view: DataView, offset: number, little: boolean) => view.getInt16(offset, little) },
  { bytes: 2, read: (view: DataView, offset: number, little: boolean) => view.getUint16(offset, little) },
  { bytes: 4, read: (view: DataView, offset: number, little: boolean) => view.getInt32(offset, little) },
  { bytes: 4, read: (view: DataView, offset: number, little: boolean) => view.getUint32(offset, little) },
  { bytes: 4, read: (view: DataView, offset: number, little: boolean) => view.getFloat32(offset, little) },
  { bytes: 8, read: (view: DataView, offset: number, little: boolean) => view.getFloat64(offset, little) }
] as const;

export function laserScanPoints(scan: LaserScan): number[] {
  if (
    !Number.isFinite(scan.angleMin) ||
    !Number.isFinite(scan.angleIncrement) ||
    !Number.isFinite(scan.rangeMin) ||
    !Number.isFinite(scan.rangeMax) ||
    scan.rangeMin < 0 ||
    scan.rangeMax < scan.rangeMin
  )
    return [];
  const positions: number[] = [];
  const stride = Math.max(1, Math.ceil(scan.ranges.length / SENSOR_POINT_LIMIT));
  for (let i = 0; i < scan.ranges.length; i += stride) {
    const range = scan.ranges[i];
    if (!Number.isFinite(range) || range < scan.rangeMin || range > scan.rangeMax) continue;
    const angle = scan.angleMin + i * scan.angleIncrement;
    const x = range * Math.cos(angle);
    const y = range * Math.sin(angle);
    if (Number.isFinite(Math.fround(x)) && Number.isFinite(Math.fround(y))) positions.push(x, y, 0);
  }
  return positions;
}

export function pointCloudPoints(cloud: PointCloud): number[] {
  if (
    !Number.isSafeInteger(cloud.width) ||
    cloud.width < 0 ||
    !Number.isSafeInteger(cloud.height) ||
    cloud.height < 0 ||
    !Number.isSafeInteger(cloud.pointStep) ||
    cloud.pointStep <= 0 ||
    !Number.isSafeInteger(cloud.rowStep) ||
    cloud.rowStep < cloud.width * cloud.pointStep ||
    !Number.isSafeInteger(cloud.width * cloud.height) ||
    cloud.fields.length !== 3
  )
    return [];
  const readers = cloud.fields.map((field) => FIELD_READERS[field.datatype]);
  for (let i = 0; i < cloud.fields.length; i++) {
    const field = cloud.fields[i];
    const reader = readers[i];
    if (
      !Number.isInteger(field.offset) ||
      field.offset < 0 ||
      reader === null ||
      reader === undefined ||
      !Number.isSafeInteger(field.count) ||
      field.count < 1 ||
      field.offset + reader.bytes * field.count > cloud.pointStep
    )
      return [];
  }
  const count = cloud.width * cloud.height;
  if (count === 0) return [];
  const requiredBytes = (cloud.height - 1) * cloud.rowStep + cloud.width * cloud.pointStep;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > cloud.data.byteLength) return [];
  const view = new DataView(cloud.data.buffer, cloud.data.byteOffset, cloud.data.byteLength);
  const positions: number[] = [];
  const stride = Math.max(1, Math.ceil(count / SENSOR_POINT_LIMIT));
  for (let i = 0; i < count; i += stride) {
    const base = Math.floor(i / cloud.width) * cloud.rowStep + (i % cloud.width) * cloud.pointStep;
    const point = cloud.fields.map((field, axis) => readers[axis]!.read(view, base + field.offset, !cloud.bigEndian));
    if (point.every((value) => Number.isFinite(Math.fround(value)))) positions.push(...point);
  }
  return positions;
}

export function readSensorPoints(log: Log, key: string, time: number, uuid?: string): number[] {
  const root = log.getRange(key, time, time, uuid);
  if (root === undefined || root.values.length === 0 || root.timestamps[0] > time) return [];
  const sampleTime = root.timestamps[0];
  const value = (suffix: string): unknown => {
    const sample = log.getRange(key + "/" + suffix, sampleTime, sampleTime, uuid);
    return sample !== undefined && sample.values.length > 0 && sample.timestamps[0] <= sampleTime
      ? sample.values[0]
      : undefined;
  };
  const numeric = (suffix: string): number => {
    const result = value(suffix);
    return typeof result === "number" ? result : NaN;
  };
  switch (classifyStructuredType(log.getStructuredType(key) ?? "")) {
    case SemanticType.LaserScan: {
      const ranges = value("ranges");
      if (!Array.isArray(ranges)) return [];
      return laserScanPoints({
        angleMin: numeric("angle_min"),
        angleIncrement: numeric("angle_increment"),
        rangeMin: numeric("range_min"),
        rangeMax: numeric("range_max"),
        ranges
      });
    }
    case SemanticType.PointCloud: {
      const data = value("data");
      const bigEndian = value("is_bigendian");
      const length = numeric("fields/length");
      if (
        !(data instanceof Uint8Array) ||
        typeof bigEndian !== "boolean" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 10000
      )
        return [];
      const fields = new Map<string, PointField>();
      for (let i = 0; i < length; i++) {
        const name = value(`fields/${i}/name`);
        if (name === "x" || name === "y" || name === "z")
          fields.set(name, {
            offset: numeric(`fields/${i}/offset`),
            datatype: numeric(`fields/${i}/datatype`),
            count: numeric(`fields/${i}/count`)
          });
      }
      if (!fields.has("x") || !fields.has("y") || !fields.has("z")) return [];
      return pointCloudPoints({
        width: numeric("width"),
        height: numeric("height"),
        pointStep: numeric("point_step"),
        rowStep: numeric("row_step"),
        bigEndian,
        fields: [fields.get("x")!, fields.get("y")!, fields.get("z")!],
        data
      });
    }
    default:
      return [];
  }
}
