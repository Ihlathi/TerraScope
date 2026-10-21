// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { SourceListConfig } from "../../shared/SourceListConfig";
import { SemanticType, structuredTypesFor } from "../../shared/log/SemanticType";

const ImageController_Config: SourceListConfig = {
  title: "Sources",
  autoAdvance: false,
  allowChildrenFromDrag: false,
  types: [
    {
      key: "image",
      display: "Image",
      symbol: "image",
      showInTypeName: false,
      color: "#888888",
      sourceTypes: structuredTypesFor([SemanticType.Image, SemanticType.CompressedImage]),
      showDocs: false,
      options: []
    }
  ]
};

export default ImageController_Config;
