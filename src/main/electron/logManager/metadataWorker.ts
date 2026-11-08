// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { parentPort } from "node:worker_threads";
import { extractMetadata } from "./Metadata";

parentPort!.on("message", async (request: { id: number; path: string }) => {
  try {
    const metadata = await extractMetadata(request.path);
    parentPort!.postMessage({ id: request.id, metadata });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, metadata: { error: String(error) } });
  }
});
