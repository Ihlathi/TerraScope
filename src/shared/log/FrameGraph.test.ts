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
