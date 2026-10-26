// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ROS2BagDecoder from "../../hub/dataSources/ros2/ROS2BagDecoder";
import { PluginRegistry } from "../plugins/PluginRegistry";
import { plugins } from "../plugins/builtins";
import { ImageFrameCache, ImageResult, compressedImageFormat, decodeRawImage, readImageFrame } from "./ImageSensor";
import Log from "./Log";
import { SemanticType } from "./SemanticType";

async function fixture(): Promise<Log> {
  const log = new Log(false);
  await new ROS2BagDecoder().decode(
    log,
    new Uint8Array(readFileSync("src/hub/dataSources/ros2/fixtures/images.db3")),
    () => {}
  );
  return log;
}

function frame(result: ImageResult) {
  assert.equal(result.status, "frame", result.status !== "frame" ? result.message : undefined);
  if (result.status !== "frame") throw new Error("Expected image frame");
  return result;
}

const encodings = ["rgb8", "bgr8", "mono8", "jpeg", "png"];

function expected(second: number, mono = false): number[] {
  const pixels = [
    [10 + second, 40 + second, 90 + second],
    [110 + second, 140 + second, 190 + second],
    [20 + second, 50 + second, 100 + second],
    [120 + second, 150 + second, 200 + second]
  ];
  return pixels.flatMap(([r, g, b]) => (mono ? [r, r, r, 255] : [r, g, b, 255]));
}

test("real ROS 2 image fixture decodes channel order, padded rows, mono, JPEG, and PNG pixels", async () => {
  const log = await fixture();
  for (const [index, encoding] of encodings.entries()) {
    const topic = "/camera/" + encoding;
    const timestamps = log.getRaw(topic, -Infinity, Infinity)!.timestamps;
    assert.equal(timestamps.length, 3);
    for (const second of [1, 2, 3]) {
      const timestamp = second + index / 10;
      const image = frame(readImageFrame(log, topic, timestamp, plugins));
      assert.equal(image.timestamp, timestamp);
      assert.deepEqual([image.width, image.height], [2, 2]);
      const want = expected(second, encoding === "mono8");
      if (encoding === "jpeg") {
        image.rgba.forEach((value, pixel) =>
          assert.ok(Math.abs(value - want[pixel]) <= 3, `${pixel}: ${value} versus ${want[pixel]}`)
        );
      } else assert.deepEqual([...image.rgba], want);
    }
  }
  const restored = Log.fromSerialized(structuredClone(log.toSerialized()));
  assert.deepEqual(
    frame(readImageFrame(restored, "/camera/bgr8", 2.1, plugins)).rgba,
    frame(readImageFrame(log, "/camera/bgr8", 2.1, plugins)).rgba
  );
});

test("selects latest at or before cursor, at, between, before, and after every fixture topic", async () => {
  const log = await fixture();
  for (const [index, encoding] of encodings.entries()) {
    const topic = "/camera/" + encoding;
    const offset = index / 10;
    assert.equal(readImageFrame(log, topic, 0.9 + offset, plugins).status, "empty");
    for (const second of [1, 2, 3]) {
      assert.equal(frame(readImageFrame(log, topic, second + offset, plugins)).timestamp, second + offset);
      assert.equal(frame(readImageFrame(log, topic, second + 0.5 + offset, plugins)).timestamp, second + offset);
    }
    assert.equal(frame(readImageFrame(log, topic, 10, plugins)).timestamp, 3 + offset);
  }
});

test("compressed format uses the real bytes and accepts ROS compound format strings", async () => {
  const log = await fixture();
  const jpeg = log.getRaw("/camera/jpeg/data", 1.3, 1.3)!.values[0];
  const png = log.getRaw("/camera/png/data", 1.4, 1.4)!.values[0];
  assert.equal(compressedImageFormat(jpeg, "rgb8; jpeg compressed bgr8"), "jpeg");
  assert.equal(compressedImageFormat(png, "rgb8; png compressed rgb8"), "png");
  assert.equal(compressedImageFormat(png, ""), "png");
  assert.throws(() => compressedImageFormat(jpeg, "png"), /does not match/);
  assert.throws(() => compressedImageFormat(png, "16UC1; compressedDepth png"), /depth/);
  assert.throws(() => compressedImageFormat(new Uint8Array([1, 2, 3]), "jpeg"), /Unsupported/);
  assert.throws(() => compressedImageFormat(png, "webp"), /Unsupported/);
});

test("registered codecs run only for selected frames and cache at most three decoded frames", async () => {
  const log = await fixture();
  const registry = new PluginRegistry();
  let calls = 0;
  registry.registerImageDecoder({
    id: "counted",
    semantic: SemanticType.Image,
    decode: (read) => {
      calls++;
      return decodeRawImage(read);
    }
  });
  const cache = new ImageFrameCache();
  assert.equal(calls, 0);
  assert.equal(cache.read(log, "/camera/rgb8", 0, registry).status, "empty");
  assert.equal(calls, 0);
  const first = frame(cache.read(log, "/camera/rgb8", 1, registry));
  assert.equal(calls, 1);
  cache.read(log, "/camera/rgb8", 2, registry);
  assert.equal(calls, 2);
  assert.strictEqual(cache.read(log, "/camera/rgb8", 1.5, registry), first);
  assert.equal(calls, 2);
  cache.read(log, "/camera/rgb8", 3, registry);
  assert.equal(calls, 3);
  log.putRaw("/camera/rgb8", 4, new Uint8Array([0]));
  log.putUnknownStruct("/camera/rgb8", 4, {
    height: 2,
    width: 2,
    encoding: "rgb8",
    is_bigendian: 0,
    step: 9,
    data: new Uint8Array([14, 44, 94, 114, 144, 194, 241, 242, 243, 24, 54, 104, 124, 154, 204, 241, 242, 243])
  });
  cache.read(log, "/camera/rgb8", 1, registry);
  cache.read(log, "/camera/rgb8", 2, registry);
  cache.read(log, "/camera/rgb8", 3, registry);
  cache.read(log, "/camera/rgb8", 4, registry);
  const before = calls;
  cache.read(log, "/camera/rgb8", 1, registry);
  assert.equal(calls, before + 1);
  const beforeChange = calls;
  cache.read(log, "/camera/bgr8", 1.1, registry);
  assert.equal(calls, beforeChange + 1);
  cache.read(log, "/camera/rgb8", 1, registry);
  assert.equal(calls, beforeChange + 2);
  cache.clear();
  cache.read(log, "/camera/rgb8", 1, registry);
  assert.equal(calls, beforeChange + 3);
});

test("corrupt unselected compressed frames stay undecoded", async () => {
  const log = await fixture();
  log.putRaw("/camera/jpeg/data", 2.3, new Uint8Array([0, 1, 2]));
  assert.equal(readImageFrame(log, "/camera/jpeg", 1.3, plugins).status, "frame");
  assert.equal(readImageFrame(log, "/camera/jpeg", 2.3, plugins).status, "error");
  assert.equal(readImageFrame(log, "/camera/jpeg", 3.3, plugins).status, "frame");
});

test("malformed raw images return visible diagnostics", async () => {
  for (const [field, value, pattern] of [
    ["is_bigendian", 1, /Big-endian/],
    ["encoding", "16UC1", /Unsupported image encoding/],
    ["step", 5, /row stride/],
    ["data", new Uint8Array([1]), /row stride/],
    ["width", -1, /dimensions/]
  ] as const) {
    const log = await fixture();
    if (typeof value === "number") log.putNumber("/camera/rgb8/" + field, 1, value);
    else if (typeof value === "string") log.putString("/camera/rgb8/" + field, 1, value);
    else log.putRaw("/camera/rgb8/" + field, 1, value);
    const result = readImageFrame(log, "/camera/rgb8", 1, plugins);
    assert.equal(result.status, "error");
    if (result.status === "error") assert.match(result.message, pattern);
  }
});

test("registry rejects duplicate decoder ids and semantic registrations", () => {
  const registry = new PluginRegistry();
  registry.registerImageDecoder({ id: "image", semantic: SemanticType.Image, decode: decodeRawImage });
  assert.throws(
    () => registry.registerImageDecoder({ id: "second", semantic: SemanticType.Image, decode: decodeRawImage }),
    /both/
  );
  assert.throws(
    () =>
      registry.registerImageDecoder({ id: "image", semantic: SemanticType.CompressedImage, decode: decodeRawImage }),
    /Duplicate/
  );
  assert.ok(plugins.getImageDecoder(SemanticType.Image));
  assert.ok(plugins.getImageDecoder(SemanticType.CompressedImage));
});
