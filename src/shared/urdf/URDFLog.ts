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

type Version = { field: LogField | null; revision: number; length: number };
type JointSample = { time: number; position: number };
type TopicCache = {
  versions: Version[];
  tracks: Map<string, JointSample[]>;
  errors: { time: number; message: string }[];
};
const cache = new WeakMap<Log, Map<string, TopicCache>>();

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
  const positions = new Map<string, number>();
  const selectedTimes = new Map<string, number>();
  const diagnostics: string[] = [];
  for (const topic of topics) {
    const versions = [topic, topic + "/name", topic + "/position"].map((key) => {
      const field = log.getField(key);
      return { field, revision: field?.getRevision() ?? 0, length: field?.getTimestampCount() ?? 0 };
    });
    let entry = entries.get(topic);
    let start = entry ? Infinity : -Infinity;
    if (entry) {
      versions.forEach((version, i) => {
        const previous = entry!.versions[i];
        if (version.field !== previous.field) {
          start = -Infinity;
        } else if (version.revision !== previous.revision && !version.field?.hasOnlyAppendedSince(previous.revision)) {
          start = -Infinity;
        } else if (version.field && version.length > previous.length) {
          start = Math.min(start, version.field.getTimestampAt(previous.length)!);
        }
      });
    } else {
      entry = { versions, tracks: new Map(), errors: [] };
      entries.set(topic, entry);
    }
    if (start < Infinity) {
      entry.tracks.forEach((samples, name) => {
        while (samples.length && samples[samples.length - 1].time >= start) samples.pop();
        if (!samples.length) entry!.tracks.delete(name);
      });
      while (entry.errors.length && entry.errors[entry.errors.length - 1].time >= start) entry.errors.pop();
      for (const stamp of log.getRange(topic, start, Infinity)?.timestamps ?? []) {
        if (stamp < start) continue;
        const names = valueAtURDFTime(log, topic + "/name", stamp);
        const values = valueAtURDFTime(log, topic + "/position", stamp);
        if (
          !Array.isArray(names) ||
          !Array.isArray(values) ||
          names.length !== values.length ||
          names.some((name) => typeof name !== "string") ||
          values.some((position) => typeof position !== "number" || !Number.isFinite(position))
        ) {
          entry.errors.push({ time: stamp, message: `${topic}: Invalid JointState names or positions at ${stamp}.` });
          continue;
        }
        names.forEach((name: string, index: number) => {
          let samples = entry!.tracks.get(name);
          if (!samples) {
            samples = [];
            entry!.tracks.set(name, samples);
          }
          samples.push({ time: stamp, position: values[index] });
        });
      }
    }
    entry.versions = versions;
    diagnostics.push(...entry.errors.map((error) => error.message));
    entry.tracks.forEach((samples, name) => {
      let low = 0,
        high = samples.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (samples[mid].time <= time) low = mid + 1;
        else high = mid;
      }
      if (low && samples[low - 1].time >= (selectedTimes.get(name) ?? -Infinity)) {
        positions.set(name, samples[low - 1].position);
        selectedTimes.set(name, samples[low - 1].time);
      }
    });
  }
  return { positions, diagnostics };
}
