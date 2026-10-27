// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import URCLSchema from "../../hub/dataSources/schema/URCLSchema";
import URCLSchemaLegacy from "../../hub/dataSources/schema/URCLSchemaLegacy";
import { decodeCompressedImage, decodeRawImage } from "../log/ImageSensor";
import { SemanticType } from "../log/SemanticType";
import { PluginRegistry } from "./PluginRegistry";

export const plugins = new PluginRegistry();

plugins.registerReader({
  id: "wpilog",
  displayName: "WPILib robot log",
  extensions: ["wpilog"],
  worker: "wpilogWorker.js"
});
plugins.registerReader({
  id: "wpilogxz",
  displayName: "Compressed WPILib robot log",
  extensions: ["wpilogxz"],
  worker: "wpilogWorker.js",
  preparation: "wpilogxz"
});
plugins.registerReader({
  id: "hoot",
  displayName: "Hoot robot log",
  extensions: ["hoot"],
  worker: "wpilogWorker.js",
  preparation: "hoot"
});
plugins.registerReader({
  id: "revlog",
  displayName: "REV Robotics CAN log",
  extensions: ["revlog"],
  worker: "wpilogWorker.js",
  preparation: "revlog"
});
plugins.registerReader({ id: "rlog", displayName: "Robot log", extensions: ["rlog"], worker: "rlogWorker.js" });
plugins.registerReader({
  id: "roadrunner",
  displayName: "Road Runner log",
  extensions: ["log"],
  worker: "roadRunnerWorker.js"
});
plugins.registerReader({
  id: "csv",
  displayName: "Comma-separated values",
  extensions: ["csv"],
  worker: "csvWorker.js"
});
plugins.registerReader({ id: "tsv", displayName: "Tab-separated values", extensions: ["tsv"], worker: "tsvWorker.js" });
plugins.registerReader({ id: "json", displayName: "JSON log", extensions: ["json"], worker: "jsonWorker.js" });
plugins.registerReader({ id: "jsonl", displayName: "JSON Lines log", extensions: ["jsonl"], worker: "jsonlWorker.js" });
plugins.registerReader({ id: "mcap", displayName: "MCAP log", extensions: ["mcap"], worker: "mcapWorker.js" });
plugins.registerReader({
  id: "ros2",
  displayName: "ROS 2 sqlite3 bag",
  extensions: ["db3"],
  worker: "ros2BagWorker.js"
});
plugins.registerReader({
  id: "dslog",
  displayName: "NI Driver Station log",
  extensions: ["dslog", "dsevents"],
  worker: "dsLogWorker.js",
  preparation: "dslog"
});

plugins.registerSchema({ id: "URCL", displayName: "URCL revision 1", decode: URCLSchemaLegacy.parseURCLr1 });
plugins.registerSchema({
  id: "URCLr2_periodic",
  displayName: "URCL revision 2 periodic frames",
  decode: URCLSchemaLegacy.parseURCLr2
});
plugins.registerSchema({
  id: "URCLr3_periodic",
  displayName: "URCL revision 3 periodic frames",
  decode: URCLSchema.parseURCLr3
});

plugins.registerImageDecoder({ id: "ros-image", semantic: SemanticType.Image, decode: decodeRawImage });
plugins.registerImageDecoder({
  id: "ros-compressed-image",
  semantic: SemanticType.CompressedImage,
  decode: decodeCompressedImage
});
