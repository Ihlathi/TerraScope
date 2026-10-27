// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { LogReaderRegistration } from "./PluginRegistry";

export const readers: readonly LogReaderRegistration[] = [
  {
    id: "wpilog",
    displayName: "WPILib robot log",
    extensions: ["wpilog"],
    worker: "wpilogWorker.js"
  },
  {
    id: "wpilogxz",
    displayName: "Compressed WPILib robot log",
    extensions: ["wpilogxz"],
    worker: "wpilogWorker.js",
    preparation: "wpilogxz"
  },
  {
    id: "hoot",
    displayName: "Hoot robot log",
    extensions: ["hoot"],
    worker: "wpilogWorker.js",
    preparation: "hoot"
  },
  {
    id: "revlog",
    displayName: "REV Robotics CAN log",
    extensions: ["revlog"],
    worker: "wpilogWorker.js",
    preparation: "revlog"
  },
  { id: "rlog", displayName: "Robot log", extensions: ["rlog"], worker: "rlogWorker.js" },
  {
    id: "roadrunner",
    displayName: "Road Runner log",
    extensions: ["log"],
    worker: "roadRunnerWorker.js"
  },
  {
    id: "csv",
    displayName: "Comma-separated values",
    extensions: ["csv"],
    worker: "csvWorker.js"
  },
  { id: "tsv", displayName: "Tab-separated values", extensions: ["tsv"], worker: "tsvWorker.js" },
  { id: "json", displayName: "JSON log", extensions: ["json"], worker: "jsonWorker.js" },
  { id: "jsonl", displayName: "JSON Lines log", extensions: ["jsonl"], worker: "jsonlWorker.js" },
  { id: "mcap", displayName: "MCAP log", extensions: ["mcap"], worker: "mcapWorker.js" },
  {
    id: "ros2",
    displayName: "ROS 2 sqlite3 bag",
    extensions: ["db3"],
    worker: "ros2BagWorker.js"
  },
  {
    id: "dslog",
    displayName: "NI Driver Station log",
    extensions: ["dslog", "dsevents"],
    worker: "dsLogWorker.js",
    preparation: "dslog"
  }
];
