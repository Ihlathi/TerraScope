// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../log/Log";
import LogField from "../log/LogField";
import LoggableType from "../log/LoggableType";

export function discoverURDFTopics(log: Log): { descriptions: string[]; joints: string[] } {
  const descriptions: string[] = [];
  const joints: string[] = [];
  for (const key of log.getFieldKeys()) {
    if (
      /(?:^|\/)robot_description$/.test(key) &&
      (log.getType(key) === LoggableType.String || log.getType(key + "/data") === LoggableType.String)
    )
      descriptions.push(key);
    if (["sensor_msgs/msg/JointState", "sensor_msgs/JointState"].includes(log.getStructuredType(key) ?? ""))
      joints.push(key);
  }
  return { descriptions, joints };
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

type Version = { field: LogField | null; history: ReturnType<LogField["getHistoryState"]> | null };
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
      return { field, history: field?.getHistoryState() ?? null };
    });
    let entry = entries.get(topic);
    let start = entry ? Infinity : -Infinity;
    let trimBoundary: number | undefined;
    if (entry) {
      versions.forEach((version, i) => {
        const previous = entry!.versions[i].history;
        const current = version.history;
        if (
          current?.source !== previous?.source ||
          current?.offsetSeconds !== previous?.offsetSeconds ||
          current?.rewriteRevision !== previous?.rewriteRevision
        ) {
          start = -Infinity;
        } else if (current && previous && current.revision !== previous.revision) {
          if (current.trimRevision !== previous.trimRevision && current.trimmedBefore !== null)
            trimBoundary = Math.max(trimBoundary ?? -Infinity, current.trimmedBefore);
          const firstNewIndex = Math.max(0, previous.count - (current.removedCount - previous.removedCount));
          const firstNewTime = version.field!.getTimestamp(firstNewIndex);
          if (firstNewTime !== undefined) start = Math.min(start, firstNewTime);
        }
      });
    } else {
      entry = { versions, tracks: new Map(), errors: [] };
      entries.set(topic, entry);
    }
    const readSample = (stamp: number, prepend = false) => {
      const names = valueAtURDFTime(log, topic + "/name", stamp);
      const values = valueAtURDFTime(log, topic + "/position", stamp);
      if (
        !Array.isArray(names) ||
        !Array.isArray(values) ||
        names.length !== values.length ||
        names.some((name) => typeof name !== "string") ||
        values.some((position) => typeof position !== "number" || !Number.isFinite(position))
      ) {
        const error = { time: stamp, message: `${topic}: Invalid JointState names or positions at ${stamp}.` };
        if (prepend) entry.errors.unshift(error);
        else entry.errors.push(error);
        return;
      }
      names.forEach((name: string, index: number) => {
        let samples = entry.tracks.get(name);
        if (!samples) {
          samples = [];
          entry.tracks.set(name, samples);
        }
        const sample = { time: stamp, position: values[index] };
        if (prepend && samples[0]?.time === stamp) samples[0] = sample;
        else if (prepend) samples.unshift(sample);
        else samples.push(sample);
      });
    };
    if (trimBoundary !== undefined && start !== -Infinity) {
      const boundary = trimBoundary;
      entry.tracks.forEach((samples) => {
        let first = 0;
        while (first + 1 < samples.length && samples[first + 1].time <= boundary) first++;
        samples.splice(0, first);
        if (samples[0].time < boundary) samples[0] = { ...samples[0], time: boundary };
      });
      let firstError = 0;
      while (firstError < entry.errors.length && entry.errors[firstError].time <= trimBoundary) firstError++;
      entry.errors.splice(0, firstError);
      if (versions[0].field?.getTimestamp(0) === trimBoundary && trimBoundary < start) readSample(trimBoundary, true);
    }
    if (start < Infinity) {
      entry.tracks.forEach((samples, name) => {
        while (samples.length && samples[samples.length - 1].time >= start) samples.pop();
        if (!samples.length) entry!.tracks.delete(name);
      });
      while (entry.errors.length && entry.errors[entry.errors.length - 1].time >= start) entry.errors.pop();
      for (const stamp of log.getRange(topic, start, Infinity)?.timestamps ?? []) {
        if (stamp < start) continue;
        readSample(stamp);
      }
    }
    entry.versions = versions;
    let low = 0,
      high = entry.errors.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (entry.errors[mid].time <= time) low = mid + 1;
      else high = mid;
    }
    for (let i = Math.max(0, low - 5); i < low && diagnostics.length < 10; i++)
      diagnostics.push(entry.errors[i].message);
    if (low > 5 && diagnostics.length < 10)
      diagnostics.push(`${topic}: ${low - 5} earlier invalid JointState samples at or before the cursor.`);
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
