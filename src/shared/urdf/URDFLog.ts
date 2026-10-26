// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../log/Log";
import LogField from "../log/LogField";
import LoggableType from "../log/LoggableType";

export function urdfDescriptionTopics(log: Log): string[] {
  return log
    .getFieldKeys()
    .filter(
      (key) =>
        /(?:^|\/)robot_description$/.test(key) &&
        (log.getType(key) === LoggableType.String || log.getType(key + "/data") === LoggableType.String)
    );
}

export function jointStateTopics(log: Log): string[] {
  return log
    .getFieldKeys()
    .filter((key) =>
      ["sensor_msgs/msg/JointState", "sensor_msgs/JointState"].includes(log.getStructuredType(key) ?? "")
    );
}

export function urdfScope(key: string): string {
  const separator = key.lastIndexOf("/");
  return separator < 0 ? "" : key.slice(0, separator);
}

export function inURDFScope(key: string, scope: string): boolean {
  const recording = (value: string) => value.match(/^\/?(?:(?:Log|Live)\d+\/)+/)?.[0] ?? "";
  return recording(key) === recording(scope + "/") && (scope === "" || key.startsWith(scope + "/"));
}

export function valueAtURDFTime(log: Log, key: string, time: number): unknown {
  const range = log.getRange(key, time, time);
  return range && range.timestamps.length && range.timestamps[0] <= time ? range.values[0] : undefined;
}

type Version = { field: LogField; revision: number };
type JointSample = { time: number; position: number };
const cache = new WeakMap<
  Log,
  Map<string, { versions: Version[]; tracks: Map<string, JointSample[]>; errors: string[] }>
>();

export function readURDFJointPositions(
  log: Log,
  topics: readonly string[],
  time: number
): { positions: Map<string, number>; diagnostics: string[] } {
  let entries = cache.get(log);
  if (!entries) {
    entries = new Map();
    cache.set(log, entries);
  }
  const key = JSON.stringify(topics);
  const versions = topics
    .flatMap((topic) => [topic, topic + "/name", topic + "/position"])
    .map((key) => log.getField(key))
    .filter((field): field is LogField => field !== null)
    .map((field) => ({ field, revision: field.getRevision() }));
  let entry = entries.get(key);
  if (
    !entry ||
    versions.length !== entry.versions.length ||
    versions.some(
      (version, i) => version.field !== entry!.versions[i].field || version.revision !== entry!.versions[i].revision
    )
  ) {
    const tracks = new Map<string, JointSample[]>();
    const errors: string[] = [];
    for (const topic of topics) {
      for (const stamp of log.getRange(topic, -Infinity, Infinity)?.timestamps ?? []) {
        const names = valueAtURDFTime(log, topic + "/name", stamp);
        const positions = valueAtURDFTime(log, topic + "/position", stamp);
        if (
          !Array.isArray(names) ||
          !Array.isArray(positions) ||
          names.length !== positions.length ||
          names.some((name) => typeof name !== "string") ||
          positions.some((position) => typeof position !== "number" || !Number.isFinite(position))
        ) {
          errors.push(`${topic}: Invalid JointState names or positions at ${stamp}.`);
          continue;
        }
        names.forEach((name: string, index: number) => {
          let samples = tracks.get(name);
          if (!samples) {
            samples = [];
            tracks.set(name, samples);
          }
          samples.push({ time: stamp, position: positions[index] });
        });
      }
    }
    tracks.forEach((samples) => samples.sort((a, b) => a.time - b.time));
    entry = { versions, tracks, errors };
    entries.set(key, entry);
  }
  const positions = new Map<string, number>();
  entry.tracks.forEach((samples, name) => {
    let low = 0,
      high = samples.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (samples[mid].time <= time) low = mid + 1;
      else high = mid;
    }
    if (low) positions.set(name, samples[low - 1].position);
  });
  return { positions, diagnostics: entry.errors };
}
