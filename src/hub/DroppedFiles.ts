// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { PluginRegistry } from "../shared/plugins/PluginRegistry";

type DroppedFiles = {
  files: string[];
  error?: { title: string; content: string };
};

export function classifyDroppedFiles(
  paths: readonly string[],
  readers: Pick<PluginRegistry, "getReader">
): DroppedFiles {
  const files: string[] = [];
  const rejected: string[] = [];
  for (const path of paths) {
    if (readers.getReader(path) !== undefined) {
      files.push(path);
    } else {
      rejected.push(path.replaceAll("\\", "/").split("/").pop()!);
    }
  }
  if (rejected.length === 0) return { files };
  return {
    files,
    error: {
      title: "Failed to open log",
      content:
        "The following files could not be opened because their file type is unsupported:\n\n" + rejected.join("\n")
    }
  };
}
