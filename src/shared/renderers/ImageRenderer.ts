// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { ImageResult } from "../log/ImageSensor";
import TabRenderer from "./TabRenderer";

export type ImageRendererCommand = { id: string; image: ImageResult };

export default class ImageRenderer implements TabRenderer {
  private canvas: HTMLCanvasElement;
  private message: HTMLElement;
  private id: string | null = null;
  private aspectRatio: number | null = null;

  constructor(root: HTMLElement) {
    this.canvas = root.getElementsByClassName("image-frame")[0] as HTMLCanvasElement;
    this.message = root.getElementsByClassName("image-message")[0] as HTMLElement;
  }

  saveState(): unknown {
    return null;
  }
  restoreState(): void {}
  getAspectRatio(): number | null {
    return this.aspectRatio;
  }

  render(command: ImageRendererCommand): void {
    if (this.id === command.id) return;
    this.dispose();
    this.id = command.id;
    const frame = command.image;
    if (frame.status !== "frame") {
      this.message.innerText = frame.message;
      return;
    }
    this.canvas.width = frame.width;
    this.canvas.height = frame.height;
    const context = this.canvas.getContext("2d")!;
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
    this.aspectRatio = frame.width / frame.height;
    this.canvas.hidden = false;
    this.message.hidden = true;
  }

  dispose(): void {
    this.id = null;
    this.aspectRatio = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.hidden = true;
    this.message.innerText = "No image selected.";
    this.message.hidden = false;
  }
}
