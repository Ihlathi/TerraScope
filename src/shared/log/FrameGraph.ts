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
type Track = { static: Edge[]; dynamic: { time: number; edge: Edge }[] };
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

  constructor(log: Log, topics: readonly string[]) {
    for (const topic of topics) {
      const samples = log.getRange(topic, -Infinity, Infinity);
      for (const time of samples?.timestamps ?? []) {
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
            track = { static: [], dynamic: [] };
            this.tracks.set(childFrame, track);
          }
          if (topic.endsWith("tf_static")) track.static.push(edge);
          else track.dynamic.push({ time, edge });
        }
      }
    }
    this.tracks.forEach((track) => track.dynamic.sort((a, b) => a.time - b.time));
  }

  defaultFixedFrame(): string {
    for (const preferred of ["map", "odom", "world"]) if (this.frames.has(preferred)) return preferred;
    const roots = [...this.frames].filter((frame) => !this.tracks.has(frame));
    return roots.length === 1 ? roots[0] : "";
  }

  private edgeAt(frame: string, time: number): Edge | FrameFailure {
    const track = this.tracks.get(frame);
    if (!track) return { status: "missing-parent", frame };
    if (track.static.length && track.dynamic.length) return { status: "invalid", frame };
    if (track.static.length) return track.static[track.static.length - 1];
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

type FieldVersion = { key: string; field: LogField; revision: number; type: string | null };
const graphCache = new WeakMap<Log, Map<string, { fields: FieldVersion[]; graph: FrameGraph }>>();

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
  const fields = log
    .getFieldKeys()
    .filter((key) => topics.some((topic) => key === topic || key.startsWith(topic + "/")))
    .map((key) => {
      const field = log.getField(key)!;
      return { key, field, revision: field.getRevision(), type: field.structuredType };
    });
  let cache = graphCache.get(log);
  if (!cache) {
    cache = new Map();
    graphCache.set(log, cache);
  }
  const cached = cache.get(namespace);
  if (
    cached &&
    fields.length === cached.fields.length &&
    fields.every((entry, i) => {
      const old = cached.fields[i];
      return (
        entry.key === old.key && entry.field === old.field && entry.revision === old.revision && entry.type === old.type
      );
    })
  )
    return cached.graph;
  const graph = new FrameGraph(log, topics);
  cache.set(namespace, { fields, graph });
  return graph;
}
