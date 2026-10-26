// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImageRendererCommand } from "../shared/renderers/ImageRenderer";
import ImageSatellitePublisher, { ImageSatelliteUpdate } from "./ImageSatellitePublisher";

function setup() {
  const sent: ImageSatelliteUpdate[] = [];
  return { sent, publisher: new ImageSatellitePublisher((update) => sent.push(structuredClone(update))) };
}

function command(id: string): ImageRendererCommand {
  return {
    id,
    image: { status: "frame", topic: "/image", timestamp: 1, width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) }
  };
}

test("unchanged image commands send pixels once and a new id sends the new frame", () => {
  const { sent, publisher } = setup();
  publisher.publish("tab", command("one"), "Camera");
  for (let i = 0; i < 10; i++) publisher.publish("tab", command("one"), "Camera");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].command?.image, command("one").image);
  publisher.publish("tab", command("two"), "Camera");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].command?.id, "two");
});

test("renaming a satellite updates its title without resending pixels", () => {
  const { sent, publisher } = setup();
  publisher.publish("tab", command("one"), "Camera");
  publisher.publish("tab", command("one"), "Front camera");
  assert.deepEqual(sent[1], { uuid: "tab", title: "Front camera" });
  publisher.publish("tab", command("one"), "Front camera");
  assert.equal(sent.length, 2);
});

test("ready, second, and reloaded windows receive targeted frames without resetting broadcasts", () => {
  const { sent, publisher } = setup();
  publisher.publish("tab", command("one"), "Camera");
  for (const satelliteId of [3, 4, 3]) {
    publisher.publish("tab", command("one"), "Camera", satelliteId);
    assert.equal(sent.at(-1)?.satelliteId, satelliteId);
    assert.equal(sent.at(-1)?.command?.id, "one");
  }
  publisher.publish("tab", command("one"), "Camera");
  assert.equal(sent.length, 4);
});

test("clearing a source or closing its last window permits fresh delivery", () => {
  const { sent, publisher } = setup();
  publisher.publish("tab", command("one"), "Camera");
  publisher.clear("tab");
  publisher.publish("tab", command("one"), "Camera");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].command?.id, "one");
});

test("delivery state is independent for each image tab", () => {
  const { sent, publisher } = setup();
  publisher.publish("first", command("same"), "Camera");
  publisher.publish("second", command("same"), "Camera");
  publisher.publish("first", command("same"), "Camera");
  assert.deepEqual(
    sent.map((update) => update.uuid),
    ["first", "second"]
  );
});
