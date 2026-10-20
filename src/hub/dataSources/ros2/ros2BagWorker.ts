// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";
import { HistoricalDataSource_WorkerRequest, HistoricalDataSource_WorkerResponse } from "../HistoricalDataSource";
import ROS2BagDecoder from "./ROS2BagDecoder";

function sendResponse(response: HistoricalDataSource_WorkerResponse) {
  self.postMessage(response);
}

self.onmessage = async (event) => {
  const request: HistoricalDataSource_WorkerRequest = event.data;
  if (request.type !== "start") return;
  try {
    const log = new Log(false);
    await new ROS2BagDecoder().decode(log, request.data[0], (value) => sendResponse({ type: "progress", value }));
    log.getChangedFields();
    sendResponse({ type: "initial", log: log.toSerialized(), isPartial: false });
  } catch (error) {
    console.error(error);
    sendResponse({ type: "failed" });
  }
};
