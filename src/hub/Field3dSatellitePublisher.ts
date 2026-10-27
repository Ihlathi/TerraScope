// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { Field3dRendererCommand, Field3dRendererURDFModel } from "../shared/renderers/Field3dRenderer";

export type Field3dSatelliteUpdate = {
  uuid: string;
  title: string;
  command: Field3dRendererCommand;
  urdfModel?: Field3dRendererURDFModel | null;
  satelliteId?: number;
};

export default class Field3dSatellitePublisher {
  private sent = new Map<string, string | null>();

  constructor(private send: (update: Field3dSatelliteUpdate) => void) {}

  publish(
    uuid: string,
    command: Field3dRendererCommand,
    model: Field3dRendererURDFModel | null,
    title: string,
    satelliteId?: number
  ): void {
    const id = model?.id ?? null;
    const update: Field3dSatelliteUpdate = { uuid, command, title };
    if (satelliteId !== undefined) {
      this.send({ ...update, urdfModel: model, satelliteId });
      return;
    }
    if (!this.sent.has(uuid) || this.sent.get(uuid) !== id) update.urdfModel = model;
    this.send(update);
    this.sent.set(uuid, id);
  }

  clear(uuid: string): void {
    this.sent.delete(uuid);
  }
}
