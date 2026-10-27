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
import { readers } from "./readers";

export const plugins = new PluginRegistry();

for (const reader of readers) plugins.registerReader(reader);

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
