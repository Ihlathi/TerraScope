// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type {
  HistoricalDataSource_WorkerRequest,
  HistoricalDataSource_WorkerResponse
} from "../hub/dataSources/HistoricalDataSource";
import Log from "../shared/log/Log";

self.onmessage = (event: MessageEvent<HistoricalDataSource_WorkerRequest>) => {
  if (event.data.type !== "start") return;
  let response: HistoricalDataSource_WorkerResponse;
  try {
    const log = new Log(false);
    const text = new TextDecoder().decode(event.data.data[0]);
    for (const line of text.split(/\r?\n/).filter((line) => line.trim().length > 0)) {
      const [timeText, key, valueText, ...extra] = line.split("\t");
      const time = Number(timeText);
      const value = Number(valueText);
      if (!key || !timeText || !valueText || extra.length > 0 || !Number.isFinite(time) || !Number.isFinite(value)) {
        throw new Error("Expected tab-separated timestamp, field name, and numeric value.");
      }
      log.putNumber(key, time, value);
    }
    log.getChangedFields();
    response = { type: "initial", log: log.toSerialized(), isPartial: false };
  } catch (error) {
    console.error(error);
    response = { type: "failed" };
  }
  self.postMessage(response);
};
