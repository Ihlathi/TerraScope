// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { DecodedImage } from "../log/ImageSensor";
import TabRenderer from "./TabRenderer";

export default class ImageRenderer implements TabRenderer {
  private IMAGE: HTMLImageElement;
  private CANVAS: HTMLCanvasElement;
  private CTX: CanvasRenderingContext2D;
  private lastUrl: string | null = null;
  private lastImageData: ImageData | null = null;
  private currentAspectRatio: number | null = null;

  constructor(root: HTMLElement) {
    this.IMAGE = root.getElementsByTagName("img")[0] as HTMLImageElement;
    this.CANVAS = document.createElement("canvas");
    this.CANVAS.style.maxWidth = "100%";
    this.CANVAS.style.maxHeight = "100%";
    this.CANVAS.style.objectFit = "contain";
    this.CANVAS.hidden = true;
    this.IMAGE.parentElement?.appendChild(this.CANVAS);
    this.CTX = this.CANVAS.getContext("2d")!;
  }

  getAspectRatio(): number | null {
    return this.currentAspectRatio;
  }

  render(command: unknown): void {
    if (command === null) {
      this.IMAGE.hidden = true;
      this.CANVAS.hidden = true;
      if (this.lastUrl && this.lastUrl.startsWith("blob:")) {
        URL.revokeObjectURL(this.lastUrl);
      }
      this.lastUrl = null;
      this.lastImageData = null;
      this.currentAspectRatio = null;
      return;
    }

    const decoded = command as DecodedImage;

    if (decoded.dataUrl !== undefined && decoded.dataUrl !== null) {
      this.CANVAS.hidden = true;
      if (this.lastUrl !== decoded.dataUrl) {
        if (this.lastUrl && this.lastUrl.startsWith("blob:")) {
          URL.revokeObjectURL(this.lastUrl);
        }
        this.IMAGE.src = decoded.dataUrl;
        this.lastUrl = decoded.dataUrl;
        this.IMAGE.hidden = false;
      }
      if (this.IMAGE.naturalWidth > 0 && this.IMAGE.naturalHeight > 0) {
        this.currentAspectRatio = this.IMAGE.naturalWidth / this.IMAGE.naturalHeight;
      }
    } else if (decoded.imageData !== undefined && decoded.imageData !== null) {
      if (this.lastUrl && this.lastUrl.startsWith("blob:")) {
        URL.revokeObjectURL(this.lastUrl);
      }
      this.lastUrl = null;
      this.IMAGE.hidden = true;

      if (this.lastImageData !== decoded.imageData) {
        this.CANVAS.width = decoded.imageData.width;
        this.CANVAS.height = decoded.imageData.height;
        this.CTX.putImageData(decoded.imageData, 0, 0);
        this.lastImageData = decoded.imageData;
        this.CANVAS.hidden = false;

        if (decoded.imageData.width > 0 && decoded.imageData.height > 0) {
          this.currentAspectRatio = decoded.imageData.width / decoded.imageData.height;
        }
      }
    } else {
      this.IMAGE.hidden = true;
      this.CANVAS.hidden = true;
      if (this.lastUrl && this.lastUrl.startsWith("blob:")) {
        URL.revokeObjectURL(this.lastUrl);
      }
      this.lastUrl = null;
      this.lastImageData = null;
      this.currentAspectRatio = null;
    }
  }

  saveState(): unknown {
    return null;
  }

  restoreState(state: unknown): void {}
}
