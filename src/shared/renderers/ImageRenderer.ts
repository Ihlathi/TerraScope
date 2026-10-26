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
  private image: HTMLImageElement;
  private message: HTMLElement;
  private id: string | null = null;
  private aspectRatio: number | null = null;

  constructor(root: HTMLElement) {
    this.image = root.getElementsByClassName("image-frame")[0] as HTMLImageElement;
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
    const id = command.id;
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d")!;
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
    this.image.onload = () => {
      if (this.id !== id) return;
      this.aspectRatio = this.image.naturalWidth / this.image.naturalHeight;
      this.image.hidden = false;
      this.message.hidden = true;
    };
    this.image.onerror = () => {
      if (this.id !== id) return;
      this.message.innerText = "Unable to display the decoded image.";
      this.image.hidden = true;
      this.message.hidden = false;
    };
    this.message.innerText = "Loading image…";
    this.image.src = canvas.toDataURL("image/png");
    canvas.width = 0;
    canvas.height = 0;
  }

  dispose(): void {
    this.id = null;
    this.aspectRatio = null;
    this.image.onload = null;
    this.image.onerror = null;
    this.image.removeAttribute("src");
    this.image.hidden = true;
    this.message.innerText = "No image selected.";
    this.message.hidden = false;
  }
}
