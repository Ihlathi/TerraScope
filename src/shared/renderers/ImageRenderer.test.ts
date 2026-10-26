// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import ImageRenderer, { ImageRendererCommand } from "./ImageRenderer";

class TestCanvas {
  hidden = true;
  private currentWidth = 0;
  private currentHeight = 0;
  pixels = new Uint8ClampedArray();
  draws = 0;

  get width(): number {
    return this.currentWidth;
  }
  set width(value: number) {
    this.currentWidth = value;
    this.pixels = new Uint8ClampedArray();
  }
  get height(): number {
    return this.currentHeight;
  }
  set height(value: number) {
    this.currentHeight = value;
    this.pixels = new Uint8ClampedArray();
  }
  getContext() {
    return {
      putImageData: (image: ImageData, x: number, y: number) => {
        assert.deepEqual([x, y], [0, 0]);
        this.pixels = new Uint8ClampedArray(image.data);
        this.draws++;
      }
    };
  }
  removeAttribute(): void {}
  toDataURL(): never {
    throw new Error("Synchronous PNG encoding is forbidden.");
  }
}

function setup() {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
  const canvas = new TestCanvas();
  const message = { hidden: false, innerText: "" };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => new TestCanvas() }
  });
  Object.defineProperty(globalThis, "ImageData", {
    configurable: true,
    value: class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    }
  });
  const root = { getElementsByClassName: (name: string) => [name === "image-frame" ? canvas : message] };
  return {
    canvas,
    message,
    renderer: new ImageRenderer(root as unknown as HTMLElement),
    cleanup() {
      for (const [name, previous] of [
        ["document", previousDocument],
        ["ImageData", previousImageData]
      ] as const) {
        if (previous === undefined) Reflect.deleteProperty(globalThis, name);
        else Object.defineProperty(globalThis, name, previous);
      }
    }
  };
}

function command(id: string, timestamp = 1, topic = "/image"): ImageRendererCommand {
  return {
    id,
    image: {
      status: "frame",
      topic,
      timestamp,
      width: 2,
      height: 1,
      rgba: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255])
    }
  };
}

test("renderer draws pixels and exposes aspect ratio synchronously without encoding PNG", () => {
  const view = setup();
  try {
    view.renderer.render(command("first"));
    assert.equal(view.renderer.getAspectRatio(), 2);
    assert.equal(view.canvas.hidden, false);
    assert.equal(view.message.hidden, true);
    assert.deepEqual([view.canvas.width, view.canvas.height], [2, 1]);
    assert.deepEqual([...view.canvas.pixels], [10, 20, 30, 255, 40, 50, 60, 255]);
    view.renderer.render(command("first"));
    assert.equal(view.canvas.draws, 1, "Repeated command does not upload pixels again");
    const second = command("second", 2);
    if (second.image.status === "frame") second.image.rgba[0] = 90;
    view.renderer.render(second);
    assert.equal(view.canvas.pixels[0], 90);
    view.renderer.render(command("first"));
    assert.equal(view.canvas.pixels[0], 10, "Rewind restores the earlier pixels");
    assert.equal(view.canvas.draws, 3);
  } finally {
    view.cleanup();
  }
});

test("empty and error commands release the previous canvas and show their diagnostic", () => {
  const view = setup();
  try {
    for (const status of ["empty", "error"] as const) {
      view.renderer.render(command("frame-" + status));
      view.renderer.render({ id: status, image: { status, message: status + " diagnostic" } });
      assert.equal(view.canvas.hidden, true);
      assert.deepEqual([view.canvas.width, view.canvas.height], [0, 0]);
      assert.equal(view.canvas.pixels.length, 0);
      assert.equal(view.renderer.getAspectRatio(), null);
      assert.equal(view.message.innerText, status + " diagnostic");
      assert.equal(view.message.hidden, false);
    }
  } finally {
    view.cleanup();
  }
});

test("topic reset and tab disposal release canvas storage and permit the current command again", () => {
  const view = setup();
  try {
    view.renderer.render(command("first"));
    view.renderer.dispose();
    assert.deepEqual([view.canvas.width, view.canvas.height], [0, 0]);
    assert.equal(view.canvas.hidden, true);
    assert.equal(view.canvas.pixels.length, 0);
    assert.equal(view.renderer.getAspectRatio(), null);
    view.renderer.render(command("other-topic", 1, "/other"));
    assert.equal(view.canvas.hidden, false);
    assert.equal(view.canvas.pixels[0], 10);
    view.renderer.dispose();
    view.renderer.dispose();
    assert.deepEqual([view.canvas.width, view.canvas.height], [0, 0]);
    view.renderer.render(command("other-topic", 1, "/other"));
    assert.equal(view.canvas.hidden, false);
    assert.equal(view.canvas.draws, 3);
  } finally {
    view.cleanup();
  }
});

test("image payload survives message-port transport into a satellite canvas", async () => {
  const view = setup();
  const { port1, port2 } = new MessageChannel();
  try {
    const received = new Promise<ImageRendererCommand>((resolve) => port2.once("message", resolve));
    port1.postMessage(command("satellite"));
    view.renderer.render(await received);
    assert.equal(view.renderer.getAspectRatio(), 2);
    assert.deepEqual([...view.canvas.pixels], [10, 20, 30, 255, 40, 50, 60, 255]);
  } finally {
    port1.close();
    port2.close();
    view.cleanup();
  }
});

test("hub and satellite templates provide an accessible image canvas", () => {
  for (const path of ["www/hub.html", "www/satellite.html"]) {
    const html = readFileSync(path, "utf8");
    assert.match(html, /id="renderer13"[^>]*class="image-renderer"/);
    assert.match(html, /<canvas class="image-frame" role="img" aria-label="Selected log image frame"[^>]*><\/canvas>/);
  }
});
