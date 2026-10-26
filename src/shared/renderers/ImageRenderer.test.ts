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
import { PNG } from "pngjs";
import ImageRenderer, { ImageRendererCommand } from "./ImageRenderer";

class TestImage {
  hidden = true;
  src = "";
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
  load(): void {
    const decoded = PNG.sync.read(Buffer.from(this.src.split(",")[1], "base64"));
    this.naturalWidth = decoded.width;
    this.naturalHeight = decoded.height;
    this.onload?.();
  }
}

function setup() {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousImageData = Object.getOwnPropertyDescriptor(globalThis, "ImageData");
  const image = new TestImage();
  const message = { hidden: false, innerText: "" };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        let pixels: { data: Uint8ClampedArray; width: number; height: number };
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            putImageData: (value: typeof pixels) => {
              pixels = value;
            }
          }),
          toDataURL: () =>
            "data:image/png;base64," +
            PNG.sync
              .write({ width: pixels.width, height: pixels.height, data: Buffer.from(pixels.data) } as PNG)
              .toString("base64")
        };
      }
    }
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
  const root = { getElementsByClassName: (name: string) => [name === "image-frame" ? image : message] };
  return {
    image,
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

test("renderer sets aspect after load and scrubs back to a valid self-contained image", () => {
  const view = setup();
  try {
    view.renderer.render(command("first"));
    assert.equal(view.renderer.getAspectRatio(), null);
    assert.equal(view.image.hidden, true);
    const first = view.image.src;
    view.image.load();
    assert.equal(view.renderer.getAspectRatio(), 2);
    assert.equal(view.image.hidden, false);
    assert.equal(view.message.hidden, true);
    const decoded = PNG.sync.read(Buffer.from(first.split(",")[1], "base64"));
    assert.deepEqual([...decoded.data], [10, 20, 30, 255, 40, 50, 60, 255]);
    view.renderer.render(command("second", 2));
    view.image.load();
    view.renderer.render(command("first"));
    view.image.load();
    assert.equal(view.image.src, first);
    assert.equal(view.renderer.getAspectRatio(), 2);
    assert.match(first, /^data:image\/png;base64,/);
    view.renderer.dispose();
    assert.equal(view.image.src, "");
    assert.equal(view.image.onload, null);
    assert.equal(view.image.onerror, null);
    assert.equal(view.renderer.getAspectRatio(), null);
  } finally {
    view.cleanup();
  }
});

test("stale loads after topic change or disposal cannot restore a removed frame", () => {
  const view = setup();
  try {
    view.renderer.render(command("first"));
    const staleLoad = view.image.onload!;
    view.renderer.render({ id: "error", image: { status: "error", message: "Unsupported image encoding" } });
    staleLoad();
    assert.equal(view.image.hidden, true);
    assert.equal(view.renderer.getAspectRatio(), null);
    assert.equal(view.message.innerText, "Unsupported image encoding");
    view.renderer.render(command("other-topic", 1, "/other"));
    const pending = view.image.onload!;
    view.renderer.dispose();
    pending();
    assert.equal(view.image.hidden, true);
    assert.equal(view.renderer.getAspectRatio(), null);
    assert.equal(view.image.src, "");
  } finally {
    view.cleanup();
  }
});

test("image payload survives message-port transport into a satellite renderer", async () => {
  const view = setup();
  const { port1, port2 } = new MessageChannel();
  try {
    const received = new Promise<ImageRendererCommand>((resolve) => port2.once("message", resolve));
    port1.postMessage(command("satellite"));
    view.renderer.render(await received);
    view.image.load();
    assert.equal(view.renderer.getAspectRatio(), 2);
    const decoded = PNG.sync.read(Buffer.from(view.image.src.split(",")[1], "base64"));
    assert.deepEqual([...decoded.data], [10, 20, 30, 255, 40, 50, 60, 255]);
  } finally {
    port1.close();
    port2.close();
    view.cleanup();
  }
});

test("hub and satellite templates permit the self-contained image payload", () => {
  for (const path of ["www/hub.html", "www/satellite.html"]) {
    const html = readFileSync(path, "utf8");
    const policies = [...html.matchAll(/content="(default-src[^"]+)"/g)];
    assert.equal(policies.length, 2);
    for (const policy of policies) {
      const imageSources = policy[1].split(";").find((directive) => directive.trim().startsWith("img-src "));
      assert.ok(imageSources?.split(/\s+/).includes("data:"), `${path} must permit renderer data URLs`);
    }
    assert.match(html, /id="renderer13"[^>]*class="image-renderer"/);
    assert.match(html, /class="image-frame"/);
  }
});
