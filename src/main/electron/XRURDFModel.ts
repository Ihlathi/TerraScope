// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { Field3dRendererURDFModel } from "../../shared/renderers/Field3dRenderer";
import type { XRPacket } from "../../shared/XRTypes";

type ModelPacket = Extract<XRPacket, { type: "urdfModel" }>;

export default class XRURDFModel {
  private model: Field3dRendererURDFModel | null = null;

  snapshot(): ModelPacket {
    return { type: "urdfModel", time: Date.now(), value: this.model };
  }

  update(model: Field3dRendererURDFModel | null): ModelPacket | null {
    if (this.model?.id === model?.id) return null;
    this.model = model;
    return this.snapshot();
  }

  clear(): void {
    this.model = null;
  }
}
