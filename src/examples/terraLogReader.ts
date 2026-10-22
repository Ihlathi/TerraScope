// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { PluginRegistry } from "../shared/plugins/PluginRegistry";

export function registerTerraLogReader(registry: PluginRegistry): void {
  registry.registerReader({
    id: "example-terralog",
    displayName: "TerraLog example",
    extensions: ["terralog"],
    worker: "terraLogWorker.js"
  });
}
