// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { SourceListState } from "../../shared/SourceListConfig";
import { readImageFrame } from "../../shared/log/ImageSensor";
import { createUUID } from "../../shared/util";
import SourceList from "../SourceList";
import ImageController_Config from "./ImageController_Config";
import TabController from "./TabController";

export default class ImageController implements TabController {
  UUID = createUUID();
  private sourceList: SourceList;
  private lastTime = -1;
  private lastTopic = "";
  private lastFrame: ReturnType<typeof readImageFrame> = null;

  constructor(root: HTMLElement) {
    this.sourceList = new SourceList(root.firstElementChild as HTMLElement, ImageController_Config, []);
  }

  getCommand(): unknown {
    const sources = this.sourceList.getState();
    const topic = sources.length > 0 ? sources[0].logKey : null;
    const time = window.selection.getRenderTime();

    if (!topic || time === null) {
      return null;
    }

    const rootSample = window.log.getRange(topic, time, time);
    if (!rootSample || rootSample.values.length === 0 || rootSample.timestamps[0] > time) {
      return null;
    }

    if (this.lastTime === rootSample.timestamps[0] && this.lastTopic === topic) {
      return this.lastFrame;
    }

    this.lastTime = rootSample.timestamps[0];
    this.lastTopic = topic;
    this.lastFrame = readImageFrame(window.log, topic, time);
    return this.lastFrame;
  }

  saveState(): unknown {
    return this.sourceList.getState();
  }

  restoreState(state: unknown): void {
    this.sourceList.setState(state as SourceListState);
  }

  refresh(): void {
    this.sourceList.refresh();
  }

  newAssets(): void {}

  getActiveFields(): string[] {
    const sources = this.sourceList.getState();
    const topic = sources.length > 0 ? sources[0].logKey : null;
    return topic ? [topic] : [];
  }

  showTimeline(): boolean {
    return true;
  }
}
