// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { FrameGraph, composeFramePose, frameGraphForSource, readSourceFrame } from "./FrameGraph";
import Log from "./Log";
import LogField from "./LogField";
import { LOG_CLOCK } from "./LogTimestamp";
import ProjectedLogField from "./ProjectedLogField";

type Transform = { parent: string; child: string; xyz?: number[]; yaw?: number; quaternion?: number[] };
function batch(log: Log, topic: string, time: number, transforms: Transform[]) {
  log.putRaw(topic, time, new Uint8Array([time, transforms.length]));
  log.setStructuredType(topic, "tf2_msgs/msg/TFMessage");
  log.putUnknownStruct(topic, time, {
    transforms: transforms.map((t) => {
      const [x, y, z] = t.xyz ?? [0, 0, 0];
      const q = t.quaternion ?? [0, 0, Math.sin((t.yaw ?? 0) / 2), Math.cos((t.yaw ?? 0) / 2)];
      return {
        header: { frame_id: t.parent },
        child_frame_id: t.child,
        transform: { translation: { x, y, z }, rotation: { x: q[0], y: q[1], z: q[2], w: q[3] } }
      };
    })
  });
}
function resolved(graph: FrameGraph, frame: string, fixed: string, time: number) {
  const result = graph.resolve(frame, fixed, time);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") throw new Error("Unresolved frame");
  return result.pose;
}
function close(actual: number[], expected: number[]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${v} != ${expected[i]}`));
}

test("compose rotated chains and resolve between sibling or inverse reference frames", () => {
  const log = new Log(false);
  batch(log, "/tf_static", 5, [
    { parent: "base", child: "laser", xyz: [1, 0, 0] },
    { parent: "base", child: "camera", xyz: [0, 2, 0] }
  ]);
  batch(log, "/tf", 1, [{ parent: "map", child: "base", xyz: [3, 4, 0], yaw: Math.PI / 2 }]);
  const graph = frameGraphForSource(log, "/scan");
  close(resolved(graph, "laser", "map", 2).translation, [3, 5, 0]);
  close(resolved(graph, "laser", "camera", 2).translation, [1, -2, 0]);
  close(resolved(graph, "map", "laser", 2).translation, [-5, 3, 0]);
  close(resolved(graph, "map", "map", 2).translation, [0, 0, 0]);
});

test("static is bag-wide while dynamic uses latest logged display time without future samples", () => {
  const log = new Log(false);
  batch(log, "/tf_static", 5, [{ parent: "base", child: "laser", xyz: [1, 0, 0] }]);
  batch(log, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  batch(log, "/tf", 2, [{ parent: "map", child: "base", xyz: [4, 0, 0] }]);
  const graph = frameGraphForSource(log, "/scan");
  close(resolved(graph, "laser", "base", -10).translation, [1, 0, 0]);
  assert.deepEqual(graph.resolve("laser", "map", 0), { status: "unavailable", frame: "base" });
  close(resolved(graph, "laser", "map", 1.5).translation, [2, 0, 0]);
  close(resolved(graph, "laser", "map", 2).translation, [5, 0, 0]);
  close(resolved(graph, "laser", "map", 100).translation, [5, 0, 0]);
  close(resolved(graph, "laser", "map", 1.5).translation, [2, 0, 0]);
});

test("sparse TF messages and reordered array slots retain independent edge histories", () => {
  const log = new Log(false);
  batch(log, "/tf", 1, [
    { parent: "map", child: "base", xyz: [1, 0, 0] },
    { parent: "base", child: "laser", xyz: [0, 1, 0] }
  ]);
  batch(log, "/tf", 2, [{ parent: "base", child: "laser", xyz: [0, 2, 0] }]);
  batch(log, "/tf", 3, [
    { parent: "base", child: "laser", xyz: [0, 3, 0] },
    { parent: "map", child: "base", xyz: [3, 0, 0] }
  ]);
  const graph = frameGraphForSource(log, "/scan");
  close(resolved(graph, "laser", "map", 2.5).translation, [1, 2, 0]);
  close(resolved(graph, "laser", "map", 3).translation, [3, 3, 0]);
});

test("missing parent, empty frame, cycle, and invalid transforms report failure", () => {
  const log = new Log(false);
  batch(log, "/tf_static", 1, [
    { parent: "missing_mount", child: "laser" },
    { parent: "map", child: "bad", quaternion: [0, 0, 0, 0] },
    { parent: "b", child: "a" },
    { parent: "a", child: "b" }
  ]);
  const graph = frameGraphForSource(log, "/scan");
  assert.deepEqual(graph.resolve("laser", "map", 1), { status: "missing-parent", frame: "missing_mount" });
  assert.equal(graph.resolve("", "map", 1).status, "missing-parent");
  assert.equal(graph.resolve("bad", "map", 1).status, "invalid");
  assert.equal(graph.resolve("a", "map", 1).status, "cycle");
});

test("static/dynamic conflicting authorities fail rather than choose silently", () => {
  const log = new Log(false);
  batch(log, "/tf_static", 1, [{ parent: "map", child: "base" }]);
  batch(log, "/tf", 2, [{ parent: "map", child: "base" }]);
  assert.equal(frameGraphForSource(log, "/scan").resolve("base", "map", 2).status, "invalid");
});

test("source frames follow the sample, while absent metadata leaves legacy objects unframed", () => {
  const log = new Log(false);
  log.putRaw("/scan", 1, new Uint8Array([1]));
  log.putString("/scan/header/frame_id", 1, "laser");
  log.putRaw("/scan", 3, new Uint8Array([3]));
  log.putString("/scan/header/frame_id", 3, "camera");
  log.putNumber("legacy", 1, 1);
  assert.equal(readSourceFrame(log, "/scan", 0), undefined);
  assert.equal(readSourceFrame(log, "/scan", 2), "laser");
  assert.equal(readSourceFrame(log, "/scan", 3), "camera");
  assert.equal(readSourceFrame(log, "legacy", 3), null);
});

test("independent recordings and live sources never share same-named frames", () => {
  const log = new Log(false);
  batch(log, "/tf_static", 1, [{ parent: "map", child: "laser", xyz: [99, 0, 0] }]);
  batch(log, "/Log0/tf_static", 1, [{ parent: "map", child: "laser", xyz: [1, 0, 0] }]);
  batch(log, "/Log1/tf_static", 1, [{ parent: "map", child: "laser", xyz: [2, 0, 0] }]);
  close(resolved(frameGraphForSource(log, "/Log0/scan"), "laser", "map", 1).translation, [1, 0, 0]);
  close(resolved(frameGraphForSource(log, "/Log1/scan"), "laser", "map", 1).translation, [2, 0, 0]);
  assert.equal(frameGraphForSource(log, "/Log2/scan").resolve("laser", "map", 1).status, "missing-parent");
  assert.equal(frameGraphForSource(log, "/Live0/scan").resolve("laser", "map", 1).status, "missing-parent");
});

test("cached graph observes appends, out-of-order inserts, same-time corrections and trimming", () => {
  const log = new Log(false);
  batch(log, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  batch(log, "/tf", 3, [{ parent: "map", child: "base", xyz: [3, 0, 0] }]);
  const at = (time: number) => resolved(frameGraphForSource(log, "/scan"), "base", "map", time).translation;
  close(at(2), [1, 0, 0]);
  batch(log, "/tf", 2, [{ parent: "map", child: "base", xyz: [2, 0, 0] }]);
  close(at(2), [2, 0, 0]);
  batch(log, "/tf", 2, [{ parent: "map", child: "base", xyz: [20, 0, 0] }]);
  close(at(2), [20, 0, 0]);
  batch(log, "/tf", 4, [{ parent: "map", child: "base", xyz: [4, 0, 0] }]);
  close(at(4), [4, 0, 0]);
  log.clearBeforeTime(3.5);
  assert.equal(frameGraphForSource(log, "/scan").resolve("base", "map", 1).status, "unavailable");
  close(at(4), [4, 0, 0]);
});

test("projected log fields expose source mutations to cached graph", () => {
  const source = new Log(false),
    projected = new Log(false);
  batch(source, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  for (const key of source.getFieldKeys())
    projected.setField(
      "/Live0" + key,
      new ProjectedLogField(source.getField(key)!, LOG_CLOCK, "/Live0", {
        from: LOG_CLOCK,
        to: LOG_CLOCK,
        offsetSeconds: 10
      })
    );
  const at = () => resolved(frameGraphForSource(projected, "/Live0/scan"), "base", "map", 11).translation;
  close(at(), [1, 0, 0]);
  batch(source, "/tf", 1, [{ parent: "map", child: "base", xyz: [9, 0, 0] }]);
  close(at(), [9, 0, 0]);
});

test("composing a frame pose preserves local object orientation", () => {
  close(
    composeFramePose(
      { translation: [1, 2, 3], rotation: [0, 0, 0, 1] },
      { translation: [2, 0, 1], rotation: [1, 0, 0, 0] }
    ).translation,
    [-1, 2, 4]
  );
});

test("unchanged renders reuse the graph without reading transform history", () => {
  const log = new Log(false);
  batch(log, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  const graph = frameGraphForSource(log, "/scan");
  const range = log.getRange.bind(log);
  let reads = 0;
  log.getRange = (...args) => {
    reads++;
    return range(...args);
  };
  for (let i = 0; i < 20; i++) {
    assert.equal(frameGraphForSource(log, "/scan"), graph);
    close(resolved(graph, "base", "map", 1).translation, [1, 0, 0]);
  }
  assert.equal(reads, 0);
});

test("live appends reuse the graph and read only new transform messages", () => {
  const log = new Log(false);
  batch(log, "/tf_static", 1, [{ parent: "base", child: "laser", xyz: [0, 1, 0] }]);
  batch(log, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  const graph = frameGraphForSource(log, "/scan");
  const range = log.getRange.bind(log);
  const reads: { key: string; start: number }[] = [];
  log.getRange = (key, start, end, ...rest) => {
    reads.push({ key, start });
    return range(key, start, end, ...rest);
  };
  batch(log, "/tf", 2, [{ parent: "map", child: "base", xyz: [2, 0, 0] }]);
  assert.equal(frameGraphForSource(log, "/scan"), graph);
  assert.ok(reads.length > 0);
  assert.ok(reads.every(({ key, start }) => (key === "/tf" ? start >= 1 : start === 2)));
  close(resolved(graph, "laser", "map", 1).translation, [1, 1, 0]);
  close(resolved(graph, "laser", "map", 2).translation, [2, 1, 0]);
  batch(log, "/tf_static", 3, [{ parent: "base", child: "laser", xyz: [0, 3, 0] }]);
  assert.equal(frameGraphForSource(log, "/scan"), graph);
  close(resolved(graph, "laser", "map", 1).translation, [1, 3, 0]);
  close(resolved(graph, "laser", "map", 2).translation, [2, 3, 0]);
  assert.equal(graph.defaultFixedFrame(), "map");
});

test("appending transforms does not scan accumulated timestamp arrays", (t) => {
  const log = new Log(false);
  for (let time = 1; time <= 4096; time++)
    batch(log, "/tf", time, [{ parent: "map", child: "base", xyz: [time, 0, 0] }]);
  let visits = 0;
  for (const key of log.getFieldKeys()) {
    const data = log.getField(key)!.toSerialized();
    data.timestamps = new Proxy(data.timestamps, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) visits++;
        return Reflect.get(target, property, receiver);
      }
    });
    log.setField(key, LogField.fromSerialized(data));
  }
  const graph = frameGraphForSource(log, "/scan");
  visits = 0;
  assert.equal(frameGraphForSource(log, "/scan"), graph);
  assert.equal(visits, 0);
  batch(log, "/tf", 4097, [{ parent: "map", child: "base", xyz: [4097, 0, 0] }]);
  visits = 0;
  frameGraphForSource(log, "/scan");
  t.diagnostic(`One live append after 4096 samples visited ${visits} timestamps.`);
  assert.ok(visits < 1000, `An append visited ${visits} timestamps from accumulated history`);
  assert.equal(frameGraphForSource(log, "/scan"), graph);
  close(resolved(graph, "base", "map", 4097).translation, [4097, 0, 0]);
  const projected = new Log(false);
  const refresh = () =>
    projected.setProjectedSources([
      {
        log,
        namespace: "/Live0",
        conversion: {
          from: { kind: "clock", id: "Live0/log" },
          to: LOG_CLOCK,
          offsetSeconds: 10
        }
      }
    ]);
  refresh();
  const projectedGraph = frameGraphForSource(projected, "/Live0/scan");
  batch(log, "/tf", 4098, [{ parent: "map", child: "base", xyz: [4098, 0, 0] }]);
  refresh();
  visits = 0;
  assert.equal(frameGraphForSource(projected, "/Live0/scan"), projectedGraph);
  t.diagnostic(`One projected live append after 4097 samples visited ${visits} timestamps.`);
  assert.ok(visits < 1000, `A projected append visited ${visits} timestamps from accumulated history`);
  close(resolved(projectedGraph, "base", "map", 4108).translation, [4098, 0, 0]);
});

test("incremental poses match a fresh graph at every boundary across sparse and reordered messages", () => {
  const log = new Log(false);
  batch(log, "/tf_static", 10, [{ parent: "base", child: "camera", xyz: [0, 2, 0] }]);
  let graphAfterFirst = frameGraphForSource(log, "/scan");
  for (let time = 1; time <= 8; time++) {
    const transforms: Transform[] = [{ parent: "map", child: "base", xyz: [time, 2, 0], yaw: time / 4 }];
    if (time % 2) transforms.push({ parent: "base", child: "laser", xyz: [0, time, 1] });
    if (time % 3 === 0) transforms.reverse();
    batch(log, "/tf", time, transforms);
    const updated = frameGraphForSource(log, "/scan");
    const fresh = new FrameGraph(log, ["/tf_static", "/tf"]);
    for (const cursor of [-1, 0, ...Array.from({ length: time * 2 + 1 }, (_, i) => i / 2), 100]) {
      for (const frame of ["laser", "camera", "base", "map", "missing"])
        for (const fixed of ["map", "camera", "laser", "base", "missing"])
          assert.deepEqual(updated.resolve(frame, fixed, cursor), fresh.resolve(frame, fixed, cursor));
    }
    assert.equal(updated.defaultFixedFrame(), fresh.defaultFixedFrame());
    if (time > 1) assert.equal(updated, graphAfterFirst);
    else graphAfterFirst = updated;
  }
});

test("late decoded children, field replacement, type changes and log replacement invalidate cached poses", () => {
  const log = new Log(false);
  batch(log, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  batch(log, "/tf", 3, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  let graph = frameGraphForSource(log, "/scan");
  log.putNumber("/tf/transforms/0/transform/translation/x", 2, 2);
  let updated = frameGraphForSource(log, "/scan");
  assert.notEqual(updated, graph);
  close(resolved(updated, "base", "map", 3).translation, [2, 0, 0]);
  const replacement = new Log(false);
  batch(replacement, "/tf", 1, [{ parent: "world", child: "base", xyz: [8, 0, 0] }]);
  graph = updated;
  log.setField("/tf/transforms/0/header/frame_id", replacement.getField("/tf/transforms/0/header/frame_id")!);
  updated = frameGraphForSource(log, "/scan");
  assert.notEqual(updated, graph);
  assert.equal(updated.defaultFixedFrame(), "world");
  close(resolved(updated, "base", "world", 3).translation, [2, 0, 0]);
  log.setStructuredType("/tf", null);
  assert.equal(frameGraphForSource(log, "/scan").resolve("base", "world", 3).status, "missing-parent");
  log.setStructuredType("/tf", "tf2_msgs/TFMessage");
  close(resolved(frameGraphForSource(log, "/scan"), "base", "world", 3).translation, [2, 0, 0]);
  const replacedLog = Log.fromSerialized(structuredClone(replacement.toSerialized()));
  assert.notEqual(frameGraphForSource(replacedLog, "/scan"), updated);
  close(resolved(frameGraphForSource(replacedLog, "/scan"), "base", "world", 3).translation, [8, 0, 0]);
});

test("new child fields retroactively complete an existing transform", () => {
  const source = new Log(false);
  batch(source, "/tf", 1, [{ parent: "map", child: "base", xyz: [4, 0, 0] }]);
  const data = structuredClone(source.toSerialized());
  delete data.fields["/tf/transforms/0/transform/rotation/x"];
  const log = Log.fromSerialized(data);
  const graph = frameGraphForSource(log, "/scan");
  assert.equal(graph.resolve("base", "map", 1).status, "invalid");
  log.putNumber("/tf/transforms/0/transform/rotation/x", 1, 0);
  const updated = frameGraphForSource(log, "/scan");
  assert.notEqual(updated, graph);
  close(resolved(updated, "base", "map", 1).translation, [4, 0, 0]);
});

test("topic priority and duplicate-time conflicts survive incremental insertion", () => {
  const log = new Log(false);
  batch(log, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  batch(log, "tf", 2, [{ parent: "map", child: "base", xyz: [20, 0, 0] }]);
  batch(log, "/tf_static", 1, [{ parent: "base", child: "laser", xyz: [0, 1, 0] }]);
  batch(log, "tf_static", 1, [{ parent: "base", child: "laser", xyz: [0, 2, 0] }]);
  const graph = frameGraphForSource(log, "/scan");
  batch(log, "/tf", 2, [{ parent: "map", child: "base", xyz: [2, 0, 0] }]);
  batch(log, "/tf_static", 2, [{ parent: "base", child: "laser", xyz: [0, 3, 0] }]);
  assert.equal(frameGraphForSource(log, "/scan"), graph);
  close(resolved(graph, "laser", "map", 2).translation, [20, 2, 0]);
  batch(log, "/tf", 3, [
    { parent: "map", child: "base", xyz: [3, 0, 0] },
    { parent: "world", child: "base", xyz: [30, 0, 0] }
  ]);
  assert.equal(frameGraphForSource(log, "/scan"), graph);
  assert.equal(graph.resolve("base", "map", 3).status, "invalid");
});

test("live projection refresh reuses history and invalidates source or clock replacement", () => {
  const source = new Log(false),
    projected = new Log(false);
  batch(source, "/tf", 1, [{ parent: "map", child: "base", xyz: [1, 0, 0] }]);
  const refresh = (log = source, offsetSeconds = 10) =>
    projected.setProjectedSources([
      {
        log,
        namespace: "/Live0",
        conversion: {
          from: { kind: "clock", id: "Live0/log" },
          to: LOG_CLOCK,
          offsetSeconds
        }
      }
    ]);
  refresh();
  const graph = frameGraphForSource(projected, "/Live0/scan");
  refresh();
  assert.equal(frameGraphForSource(projected, "/Live0/scan"), graph);
  batch(source, "/tf", 2, [{ parent: "map", child: "base", xyz: [2, 0, 0] }]);
  refresh();
  assert.equal(frameGraphForSource(projected, "/Live0/scan"), graph);
  close(resolved(graph, "base", "map", 12).translation, [2, 0, 0]);
  refresh(source, 20);
  const shifted = frameGraphForSource(projected, "/Live0/scan");
  assert.notEqual(shifted, graph);
  assert.equal(shifted.resolve("base", "map", 12).status, "unavailable");
  close(resolved(shifted, "base", "map", 22).translation, [2, 0, 0]);
  const replacement = new Log(false);
  batch(replacement, "/tf", 1, [{ parent: "odom", child: "base", xyz: [9, 0, 0] }]);
  refresh(replacement);
  const replaced = frameGraphForSource(projected, "/Live0/scan");
  assert.notEqual(replaced, shifted);
  assert.equal(replaced.defaultFixedFrame(), "odom");
  close(resolved(replaced, "base", "odom", 11).translation, [9, 0, 0]);
});

test("transform field range boundaries preserve held values, future endpoints and cached seeks", () => {
  const log = new Log(false);
  for (const time of [1, 3, 5]) log.putNumber("value", time, time * 10);
  const field = log.getField("value")!;
  for (const [start, end, expected] of [
    [-Infinity, Infinity, [1, 3, 5]],
    [-1, 0, [1]],
    [0, 2, [1, 3]],
    [1, 1, [1]],
    [2, 2, [1, 3]],
    [3, 3, [3]],
    [4, 4, [3, 5]],
    [9, 9, [5]],
    [2, 4, [1, 3, 5]]
  ] as const) {
    assert.deepEqual(field.getRange(start, end).timestamps, expected);
    assert.deepEqual(field.getRange(start, end, "cursor").timestamps, expected);
  }
  for (const time of [5, 1, 4, 2, 3])
    assert.deepEqual(field.getRange(time, time, "cursor"), field.getRange(time, time));
  assert.deepEqual(field.getRange(3, 5, undefined, -1).timestamps, [1, 3, 5]);
  field.clearBeforeTime(3.5);
  assert.deepEqual(field.getRange(3.5, 3.5, "cursor"), { timestamps: [3.5], values: [30] });
  const empty = new LogField(field.getType());
  assert.deepEqual(empty.getRange(0, 0, "cursor"), { timestamps: [], values: [] });
});
