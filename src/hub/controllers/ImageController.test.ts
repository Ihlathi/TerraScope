// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { SourceListState } from "../../shared/SourceListConfig";
import { ImageFrameCache } from "../../shared/log/ImageSensor";
import Log from "../../shared/log/Log";
import * as semanticTypes from "../../shared/log/SemanticType";
import { plugins } from "../../shared/plugins/builtins";
import type { ImageRendererCommand } from "../../shared/renderers/ImageRenderer";

function controllerSetup() {
  const log = new Log(false);
  let time = 0;
  let sources: SourceListState = [];
  let clears = 0;
  const window = { log, selection: { getRenderTime: () => time } };
  const dependencies: Record<string, unknown> = {
    "../../shared/log/ImageSensor": { ImageFrameCache },
    "../../shared/log/SemanticType": semanticTypes,
    "../../shared/plugins/builtins": { plugins },
    "../../shared/util": { createUUID: () => "initial" },
    "../SourceList": {
      __esModule: true,
      default: class {
        getState() {
          return sources;
        }
        setState(state: SourceListState) {
          sources = state;
        }
        refresh() {}
        stop() {}
      }
    }
  };
  const script = ts.transpileModule(readFileSync("src/hub/controllers/ImageController.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const exports: {
    default?: new (
      root: unknown,
      clear: () => void
    ) => {
      UUID: string;
      getCommand(): ImageRendererCommand;
      restoreState(state: SourceListState): void;
      dispose(): void;
    };
  } = {};
  runInNewContext(script, {
    exports,
    window,
    require(name: string) {
      assert(name in dependencies, name);
      return dependencies[name];
    }
  });
  const controller = new exports.default!({ firstElementChild: {} }, () => clears++);
  return {
    controller,
    log,
    select: (value: number) => {
      time = value;
    },
    window,
    clears: () => clears
  };
}

test("controller keeps empty and repeated decoder errors stable across cursor and field revisions", () => {
  const view = controllerSetup();
  const noSource = view.controller.getCommand();
  assert.equal(view.controller.getCommand().id, noSource.id);
  view.log.putRaw("/image", 1, new Uint8Array([1]));
  view.log.setStructuredType("/image", "sensor_msgs/msg/Image");
  view.controller.restoreState([
    { logKey: "/image", logType: "sensor_msgs/msg/Image", type: "image", visible: true, options: {} }
  ]);
  const future = view.controller.getCommand();
  assert.equal(future.image.status, "empty");
  view.select(0.5);
  assert.equal(view.controller.getCommand().id, future.id);
  view.select(1);
  const error = view.controller.getCommand();
  assert.equal(error.image.status, "error");
  view.log.putRaw("/image/data", 1, new Uint8Array([9]));
  assert.equal(view.controller.getCommand().id, error.id);
  view.log.putNumber("/image/width", 1, 1);
  view.log.putNumber("/image/height", 1, 1);
  const changedError = view.controller.getCommand();
  assert.equal(changedError.image.status, "error");
  assert.notEqual(changedError.id, error.id);
});

test("controller source reset and layout UUID replacement invalidate old commands", () => {
  const view = controllerSetup();
  const first = view.controller.getCommand();
  view.controller.UUID = "restored";
  assert.match(view.controller.getCommand().id, /^restored\//);
  view.controller.restoreState([]);
  assert.notEqual(view.controller.getCommand().id, first.id);
  const beforeDispose = view.clears();
  view.controller.dispose();
  assert.equal(view.clears(), beforeDispose + 1);
});

function source(topic: string): SourceListState {
  return [{ logKey: topic, logType: "sensor_msgs/msg/Image", type: "image", visible: true, options: {} }];
}

function writeImage(log: Log, topic: string, time: number, rgb: number[]): void {
  log.putRaw(topic, time, new Uint8Array(rgb));
  log.setStructuredType(topic, "sensor_msgs/msg/Image");
  log.putNumber(topic + "/width", time, 1);
  log.putNumber(topic + "/height", time, 1);
  log.putNumber(topic + "/is_bigendian", time, 0);
  log.putNumber(topic + "/step", time, 3);
  log.putString(topic + "/encoding", time, "rgb8");
  log.putRaw(topic + "/data", time, new Uint8Array(rgb));
}

test("cached frames keep ids, cursor changes replace frames, and same-timestamp revisions repaint", () => {
  const view = controllerSetup();
  writeImage(view.log, "/image", 1, [1, 2, 3]);
  writeImage(view.log, "/image", 2, [4, 5, 6]);
  view.controller.restoreState(source("/image"));
  view.select(1);
  const first = view.controller.getCommand();
  assert.equal(first.image.status, "frame");
  assert.equal(view.controller.getCommand().id, first.id);
  view.select(2);
  const second = view.controller.getCommand();
  assert.notEqual(second.id, first.id);
  view.select(1);
  const rewind = view.controller.getCommand();
  assert.deepEqual(rewind.image, first.image);
  assert.notEqual(rewind.id, second.id);
  view.log.putRaw("/image/data", 1, new Uint8Array([9, 8, 7]));
  const revised = view.controller.getCommand();
  assert.notEqual(revised.id, rewind.id);
  assert.equal(revised.image.status, "frame");
  if (revised.image.status === "frame") assert.deepEqual([...revised.image.rgba], [9, 8, 7, 255]);
});

test("source and log changes replace equal empty states and clear the old renderer", () => {
  const view = controllerSetup();
  view.controller.restoreState(source("/first"));
  const first = view.controller.getCommand();
  const clears = view.clears();
  view.controller.restoreState(source("/second"));
  const second = view.controller.getCommand();
  assert.deepEqual(second.image, first.image);
  assert.notEqual(second.id, first.id);
  assert(view.clears() > clears);
  view.window.log = new Log(false);
  const replaced = view.controller.getCommand();
  assert.deepEqual(replaced.image, second.image);
  assert.notEqual(replaced.id, second.id);
  assert.equal(view.controller.getCommand().id, replaced.id);
});

test("frame and message transitions always replace the command", () => {
  const view = controllerSetup();
  writeImage(view.log, "/image", 1, [1, 2, 3]);
  view.controller.restoreState(source("/image"));
  const empty = view.controller.getCommand();
  view.select(1);
  const image = view.controller.getCommand();
  view.log.putString("/image/encoding", 1, "depth");
  const error = view.controller.getCommand();
  assert.equal(empty.image.status, "empty");
  assert.equal(image.image.status, "frame");
  assert.equal(error.image.status, "error");
  assert.notEqual(empty.id, image.id);
  assert.notEqual(image.id, error.id);
  view.log.putString("/image/encoding", 1, "rgb8");
  const restored = view.controller.getCommand();
  assert.equal(restored.image.status, "frame");
  assert.notEqual(restored.id, error.id);
});
