// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { Pose3d, Rotation3d, Translation3d } from "../geometry";
import Log from "./Log";
import LogField from "./LogField";

export type FrameResolution =
  | { status: "resolved"; pose: Pose3d }
  | { status: "missing-parent" | "unavailable" | "invalid" | "cycle"; frame: string };

type FrameFailure = Exclude<FrameResolution, { status: "resolved" }>;

type Edge = { parent: string; pose: Pose3d | null };
type Track = { static: { topic: number; edge: Edge } | null; dynamic: { time: number; topic: number; edge: Edge }[] };
const identity = (): Pose3d => ({ translation: [0, 0, 0], rotation: [1, 0, 0, 0] });

function multiply(a: Rotation3d, b: Rotation3d): Rotation3d {
  const [w, x, y, z] = a;
  const [v, i, j, k] = b;
  return [
    w * v - x * i - y * j - z * k,
    w * i + x * v + y * k - z * j,
    w * j - x * k + y * v + z * i,
    w * k + x * j - y * i + z * v
  ];
}

function rotate(q: Rotation3d, point: Translation3d): Translation3d {
  const p = multiply(multiply(q, [0, ...point]), [q[0], -q[1], -q[2], -q[3]]);
  return [p[1], p[2], p[3]];
}

export function composeFramePose(parent: Pose3d, child: Pose3d): Pose3d {
  const p = rotate(parent.rotation, child.translation);
  return {
    translation: [p[0] + parent.translation[0], p[1] + parent.translation[1], p[2] + parent.translation[2]],
    rotation: multiply(parent.rotation, child.rotation)
  };
}

function inverse(pose: Pose3d): Pose3d {
  const [w, x, y, z] = pose.rotation;
  const rotation: Rotation3d = [w, -x, -y, -z];
  return { rotation, translation: rotate(rotation, pose.translation.map((v) => -v) as Translation3d) };
}

function valueAt(log: Log, key: string, time: number): unknown {
  const sample = log.getRange(key, time, time);
  return sample && sample.timestamps.length > 0 && sample.timestamps[0] <= time ? sample.values[0] : undefined;
}

export function readSourceFrame(log: Log, key: string, time: number): string | null | undefined {
  if (log.getField(key + "/header/frame_id") === null) return null;
  const root = log.getRange(key, time, time);
  if (!root || root.timestamps.length === 0 || root.timestamps[0] > time) return undefined;
  const frame = valueAt(log, key + "/header/frame_id", root.timestamps[0]);
  return typeof frame === "string" ? frame.trim() : "";
}

export function transformTopics(log: Log): string[] {
  return log
    .getFieldKeys()
    .filter(
      (key) =>
        /(?:^|\/)tf(?:_static)?$/.test(key) &&
        ["tf2_msgs/msg/TFMessage", "tf2_msgs/TFMessage"].includes(log.getStructuredType(key) ?? "")
    );
}

export class FrameGraph {
  private tracks = new Map<string, Track>();
  private frames = new Set<string>();
  private topicTimes = new Map<string, number>();

  constructor(log: Log, topics: readonly string[]) {
    this.append(log, topics);
  }

  getTopicTime(topic: string): number {
    return this.topicTimes.get(topic) ?? -Infinity;
  }

  append(log: Log, topics: readonly string[]) {
    for (const [topicIndex, topic] of topics.entries()) {
      const after = this.getTopicTime(topic);
      const field = log.getField(topic)!;
      const lastTime = field.getTimestamp(field.getHistoryState().count - 1);
      if (lastTime === undefined || (this.topicTimes.has(topic) && lastTime <= after)) continue;
      const samples = log.getRange(topic, after, Infinity);
      for (const time of samples?.timestamps ?? []) {
        if (this.topicTimes.has(topic) && time <= after) continue;
        this.topicTimes.set(topic, time);
        const length = valueAt(log, topic + "/transforms/length", time);
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 100000) continue;
        for (let i = 0; i < length; i++) {
          const key = topic + "/transforms/" + i;
          const child = valueAt(log, key + "/child_frame_id", time);
          if (typeof child !== "string" || child.trim() === "") continue;
          const parent = valueAt(log, key + "/header/frame_id", time);
          const numbers = [
            "translation/x",
            "translation/y",
            "translation/z",
            "rotation/w",
            "rotation/x",
            "rotation/y",
            "rotation/z"
          ].map((suffix) => valueAt(log, key + "/transform/" + suffix, time));
          let pose: Pose3d | null = null;
          if (numbers.every((v) => typeof v === "number" && Number.isFinite(v))) {
            const n = numbers as number[];
            const norm = Math.hypot(...n.slice(3));
            if (norm > 0 && Number.isFinite(norm))
              pose = {
                translation: n.slice(0, 3) as Translation3d,
                rotation: n.slice(3).map((v) => v / norm) as Rotation3d
              };
          }
          const edge: Edge = { parent: typeof parent === "string" ? parent.trim() : "", pose };
          const childFrame = child.trim();
          this.frames.add(childFrame);
          if (edge.parent) this.frames.add(edge.parent);
          let track = this.tracks.get(childFrame);
          if (!track) {
            track = { static: null, dynamic: [] };
            this.tracks.set(childFrame, track);
          }
          if (topic.endsWith("tf_static")) {
            if (track.static === null || topicIndex >= track.static.topic) track.static = { topic: topicIndex, edge };
          } else {
            let low = 0,
              high = track.dynamic.length;
            while (low < high) {
              const mid = (low + high) >>> 1;
              const sample = track.dynamic[mid];
              if (sample.time < time || (sample.time === time && sample.topic <= topicIndex)) low = mid + 1;
              else high = mid;
            }
            track.dynamic.splice(low, 0, { time, topic: topicIndex, edge });
          }
        }
      }
    }
  }

  defaultFixedFrame(): string {
    for (const preferred of ["map", "odom", "world"]) if (this.frames.has(preferred)) return preferred;
    const roots = [...this.frames].filter((frame) => !this.tracks.has(frame));
    return roots.length === 1 ? roots[0] : "";
  }

  private edgeAt(frame: string, time: number): Edge | FrameFailure {
    const track = this.tracks.get(frame);
    if (!track) return { status: "missing-parent", frame };
    if (track.static !== null && track.dynamic.length) return { status: "invalid", frame };
    if (track.static !== null) return track.static.edge;
    let low = 0,
      high = track.dynamic.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (track.dynamic[mid].time <= time) low = mid + 1;
      else high = mid;
    }
    if (low === 0) return { status: "unavailable", frame };
    const sample = track.dynamic[low - 1];
    if (
      low > 1 &&
      track.dynamic[low - 2].time === sample.time &&
      track.dynamic[low - 2].edge.parent !== sample.edge.parent
    )
      return { status: "invalid", frame };
    return sample.edge;
  }

  resolve(frame: string, fixedFrame: string, time: number): FrameResolution {
    if (!frame || !fixedFrame) return { status: "missing-parent", frame: frame || "(empty frame id)" };
    const ancestors = new Map<string, Pose3d>();
    let current = frame,
      pose = identity();
    let failure: FrameFailure = { status: "missing-parent", frame: current };
    while (!ancestors.has(current)) {
      ancestors.set(current, pose);
      if (current === fixedFrame) return { status: "resolved", pose };
      const edge = this.edgeAt(current, time);
      if ("status" in edge) {
        failure = edge;
        break;
      }
      if (!edge.pose || !edge.parent) {
        failure = { status: "invalid", frame: current };
        break;
      }
      pose = composeFramePose(edge.pose, pose);
      current = edge.parent;
      if (ancestors.has(current)) failure = { status: "cycle", frame: current };
    }
    const seen = new Set<string>();
    current = fixedFrame;
    pose = identity();
    while (!seen.has(current)) {
      const sourcePose = ancestors.get(current);
      if (sourcePose) return { status: "resolved", pose: composeFramePose(inverse(pose), sourcePose) };
      seen.add(current);
      const edge = this.edgeAt(current, time);
      if ("status" in edge)
        return failure.status === "missing-parent" && edge.status !== "missing-parent" ? edge : failure;
      if (!edge.pose || !edge.parent) return { status: "invalid", frame: current };
      pose = composeFramePose(edge.pose, pose);
      current = edge.parent;
    }
    return { status: "cycle", frame: current };
  }
}

type FieldVersion = ReturnType<LogField["getHistoryState"]> & { field: LogField; type: string | null };
const graphCache = new WeakMap<
  Log,
  Map<string, { topics: string[]; fields: Map<string, FieldVersion>; graph: FrameGraph }>
>();

export function frameGraphForSource(log: Log, sourceKey: string): FrameGraph {
  const allTopics = transformTopics(log);
  const sourceScope = sourceKey.match(/^\/?(?:(?:Log|Live)\d+\/)+/)?.[0].replace(/\/$/, "");
  const namespace =
    allTopics
      .map((topic) => topic.replace(/(?:^|\/)tf(?:_static)?$/, ""))
      .filter(
        (prefix) =>
          (!sourceScope || prefix === sourceScope || prefix.startsWith(sourceScope + "/")) &&
          (prefix === "" || sourceKey.startsWith(prefix + "/"))
      )
      .sort((a, b) => b.length - a.length)[0] ??
    sourceScope ??
    "";
  const topics = allTopics.filter((topic) => topic.replace(/(?:^|\/)tf(?:_static)?$/, "") === namespace);
  const fields = new Map(
    log
      .getFieldKeys()
      .filter((key) => topics.some((topic) => key === topic || key.startsWith(topic + "/")))
      .map((key) => {
        const field = log.getField(key)!;
        return [key, { field, ...field.getHistoryState(), type: field.structuredType }] as const;
      })
  );
  let cache = graphCache.get(log);
  if (!cache) {
    cache = new Map();
    graphCache.set(log, cache);
  }
  const cached = cache.get(namespace);
  const sameTopics =
    cached && topics.length === cached.topics.length && topics.every((topic, i) => topic === cached.topics[i]);
  let unchanged = sameTopics && fields.size === cached.fields.size;
  let appendOnly = sameTopics && [...cached.fields.keys()].every((key) => fields.has(key));
  for (const [key, entry] of fields) {
    const old = cached?.fields.get(key);
    const sameField =
      old && entry.source === old.source && entry.offsetSeconds === old.offsetSeconds && entry.type === old.type;
    if (sameField && entry.revision === old.revision) continue;
    unchanged = false;
    if (!appendOnly) continue;
    if (old && (!sameField || entry.nonAppendRevision !== old.nonAppendRevision || entry.count < old.count)) {
      appendOnly = false;
      continue;
    }
    const firstNewTime = entry.field.getTimestamp(old?.count ?? 0);
    const topic = topics.find((topic) => key === topic || key.startsWith(topic + "/"))!;
    if (firstNewTime !== undefined && firstNewTime <= cached!.graph.getTopicTime(topic)) appendOnly = false;
  }
  if (unchanged) return cached!.graph;
  const graph = appendOnly ? cached!.graph : new FrameGraph(log, topics);
  if (appendOnly) graph.append(log, topics);
  cache.set(namespace, { topics, fields, graph });
  return graph;
}
