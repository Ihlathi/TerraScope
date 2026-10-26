// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { SourceListConfig, SourceListState } from "../../shared/SourceListConfig";
import { ImageFrameCache, ImageResult } from "../../shared/log/ImageSensor";
import type Log from "../../shared/log/Log";
import { SemanticType, structuredTypesFor } from "../../shared/log/SemanticType";
import { plugins } from "../../shared/plugins/builtins";
import { ImageRendererCommand } from "../../shared/renderers/ImageRenderer";
import { createUUID } from "../../shared/util";
import SourceList from "../SourceList";
import TabController from "./TabController";

const CONFIG: SourceListConfig = {
  title: "Image source (first visible topic)",
  autoAdvance: false,
  allowChildrenFromDrag: false,
  types: [
    {
      key: "image",
      display: "Image",
      symbol: "photocamera",
      showInTypeName: false,
      color: "#888888",
      sourceTypes: structuredTypesFor([SemanticType.Image, SemanticType.CompressedImage]),
      showDocs: false,
      options: []
    }
  ]
};

export default class ImageController implements TabController {
  UUID = createUUID();
  private sources: SourceList;
  private cache = new ImageFrameCache();
  private lastImage: ImageResult | null = null;
  private commandId = 0;
  private topic: string | null = null;
  private log: Log | null = null;

  constructor(
    root: HTMLElement,
    private clearFrame: () => void
  ) {
    this.sources = new SourceList(root.firstElementChild as HTMLElement, CONFIG, []);
  }

  saveState(): unknown {
    return this.sources.getState();
  }
  restoreState(state: unknown): void {
    this.resetFrame();
    this.sources.setState(state as SourceListState);
  }
  refresh(): void {
    this.sources.refresh();
    this.updateSource();
  }
  newAssets(): void {}
  getActiveFields(): string[] {
    return this.sources.getActiveFields();
  }
  showTimeline(): boolean {
    return true;
  }

  getCommand(): ImageRendererCommand {
    const time = window.selection.getRenderTime() ?? window.log.getTimestampRange()[1];
    const topic = this.updateSource();
    const image = this.cache.read(window.log, topic, time, plugins, this.UUID);
    const sameMessage =
      image.status !== "frame" &&
      this.lastImage !== null &&
      this.lastImage.status === image.status &&
      this.lastImage.message === image.message;
    if (image !== this.lastImage && !sameMessage) this.commandId++;
    this.lastImage = image;
    return { id: this.UUID + "/" + this.commandId, image };
  }

  private updateSource(): string | null {
    const topic = this.sources.getState(true)[0]?.logKey ?? null;
    if (this.topic !== topic || this.log !== window.log) {
      this.resetFrame();
      this.topic = topic;
      this.log = window.log;
    }
    return topic;
  }

  private resetFrame(): void {
    this.cache.clear();
    this.lastImage = null;
    this.clearFrame();
  }

  dispose(): void {
    this.resetFrame();
    this.sources.stop();
  }
}
