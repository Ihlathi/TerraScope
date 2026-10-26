// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { ImageRendererCommand } from "../shared/renderers/ImageRenderer";

export type ImageSatelliteUpdate = {
  uuid: string;
  title: string;
  command?: ImageRendererCommand;
  satelliteId?: number;
};

export default class ImageSatellitePublisher {
  private sent = new Map<string, { id: string; title: string }>();

  constructor(private send: (update: ImageSatelliteUpdate) => void) {}

  publish(uuid: string, command: ImageRendererCommand, title: string, satelliteId?: number): void {
    if (satelliteId !== undefined) {
      this.send({ uuid, command, title, satelliteId });
      return;
    }
    const previous = this.sent.get(uuid);
    if (previous?.id !== command.id) {
      this.send({ uuid, command, title });
    } else if (previous.title !== title) {
      this.send({ uuid, title });
    } else {
      return;
    }
    this.sent.set(uuid, { id: command.id, title });
  }

  clear(uuid: string): void {
    this.sent.delete(uuid);
  }
}
