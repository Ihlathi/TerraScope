// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { NeonColors, NeonColors_RedStart } from "../../shared/Colors";
import { SourceListConfig } from "../../shared/SourceListConfig";
import { SemanticType, structuredTypesFor } from "../../shared/log/SemanticType";
import { SwerveArrangementValues } from "./SwerveController_Config";

const Field3dController_Config: SourceListConfig = {
  title: "Poses",
  autoAdvance: true,
  allowChildrenFromDrag: false,
  typeMemoryId: "field3d",
  types: [
    {
      key: "laserScan",
      display: "Laser Scan",
      symbol: "sensors",
      showInTypeName: true,
      color: "color",
      sourceTypes: structuredTypesFor([SemanticType.LaserScan]),
      showDocs: false,
      options: [{ key: "color", display: "Color", showInTypeName: false, values: NeonColors }],
      previewType: null
    },
    {
      key: "pointCloud",
      display: "Point Cloud",
      symbol: "scatterplot",
      showInTypeName: true,
      color: "color",
      sourceTypes: structuredTypesFor([SemanticType.PointCloud]),
      showDocs: false,
      options: [{ key: "color", display: "Color", showInTypeName: false, values: NeonColors }],
      previewType: null
    },
    {
      key: "robot",
      display: "Robot",
      symbol: "nearme",
      showInTypeName: false,
      color: "#000000",
      darkColor: "#ffffff",
      sourceTypes: structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d]),
      showDocs: true,
      options: [
        {
          key: "model",
          display: "Model",
          showInTypeName: true,
          values: []
        }
      ],
      initialSelectionOption: "model",
      parentKey: "robot",
      previewType: "Pose3d"
    },
    {
      key: "ghost",
      display: "Ghost",
      symbol: "nearmeoutline",
      showInTypeName: true,
      color: "color",
      sourceTypes: structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d]),
      showDocs: true,
      options: [
        {
          key: "model",
          display: "Model",
          showInTypeName: true,
          values: []
        },
        {
          key: "color",
          display: "Color",
          showInTypeName: false,
          values: NeonColors
        }
      ],
      initialSelectionOption: "model",
      parentKey: "robot",
      previewType: "Pose3d"
    },
    {
      key: "component",
      display: "Component",
      symbol: "extension",
      showInTypeName: true,
      color: "#9370db",
      sourceTypes: structuredTypesFor([SemanticType.Pose3d]),
      showDocs: true,
      options: [],
      childOf: "robot",
      previewType: "Pose3d"
    },
    {
      key: "mechanism",
      display: "Mechanism",
      symbol: "settings",
      showInTypeName: true,
      color: "#888888",
      sourceTypes: structuredTypesFor([SemanticType.MechanismJoint]),
      showDocs: true,
      options: [
        {
          key: "plane",
          display: "Plane",
          showInTypeName: false,
          values: [
            { key: "xz", display: "XZ Plane" },
            { key: "yz", display: "YZ Plane" }
          ]
        }
      ],
      childOf: "robot"
    },
    {
      key: "vision",
      display: "Vision Target",
      symbol: "target",
      showInTypeName: true,
      color: "color",
      sourceTypes: structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d, SemanticType.Translation]),
      showDocs: true,
      options: [
        {
          key: "color",
          display: "Color",
          showInTypeName: false,
          values: NeonColors
        },
        {
          key: "size",
          display: "Thickness",
          showInTypeName: false,
          values: [
            { key: "normal", display: "Normal" },
            { key: "bold", display: "Bold" }
          ]
        }
      ],
      childOf: "robot",
      previewType: "Translation3d"
    },
    {
      key: "swerveModuleVelocities",
      display: "Swerve Module Velocities",
      symbol: "zoomoutmap",
      showInTypeName: true,
      color: "color",
      sourceTypes: ["SwerveModuleVelocity[]", "SwerveModuleState[]"],
      showDocs: true,
      options: [
        {
          key: "color",
          display: "Color",
          showInTypeName: false,
          values: NeonColors_RedStart
        },
        {
          key: "arrangement",
          display: "Arrangement",
          showInTypeName: false,
          values: SwerveArrangementValues
        }
      ],
      initialSelectionOption: "color",
      childOf: "robot",
      previewType: "ModuleVelocities"
    },
    {
      key: "rotationOverride",
      display: "Rotation Override",
      symbol: "360",
      showInTypeName: true,
      color: "#000000",
      darkColor: "#ffffff",
      sourceTypes: structuredTypesFor([SemanticType.Rotation], { shape: "scalar" }),
      showDocs: true,
      options: [],
      childOf: "robot",
      previewType: "Rotation3d"
    },
    {
      key: "rotationOverrideLegacy",
      display: "Rotation Override",
      symbol: "360",
      showInTypeName: true,
      color: "#000000",
      darkColor: "#ffffff",
      sourceTypes: structuredTypesFor([SemanticType.NumericSeries]),
      showDocs: false,
      options: [
        {
          key: "units",
          display: "Rotation Units",
          showInTypeName: false,
          values: [
            { key: "radians", display: "Radians" },
            { key: "degrees", display: "Degrees" }
          ]
        }
      ],
      childOf: "robot",
      previewType: "Rotation3d"
    },
    {
      key: "gamePiece",
      display: "Game Piece",
      symbol: "chesspawn",
      showInTypeName: false,
      color: "#ffd700",
      sourceTypes: structuredTypesFor([SemanticType.Pose3d, SemanticType.Translation], { dimension: 3 }),
      showDocs: true,
      options: [
        {
          key: "variant",
          display: "Variant",
          showInTypeName: true,
          values: []
        }
      ],
      initialSelectionOption: "variant",
      previewType: "Pose3d"
    },
    {
      key: "trajectory",
      display: "Trajectory",
      symbol: "conversionpath",
      showInTypeName: true,
      color: "color",
      sourceTypes: [
        ...structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d, SemanticType.Translation], {
          shape: "array"
        }),
        ...structuredTypesFor([SemanticType.Trajectory])
      ],
      showDocs: true,
      options: [
        {
          key: "color",
          display: "Color",
          showInTypeName: false,
          values: NeonColors
        },
        {
          key: "size",
          display: "Thickness",
          showInTypeName: false,
          values: [
            { key: "normal", display: "Normal" },
            { key: "bold", display: "Bold" }
          ]
        }
      ],
      previewType: "Translation3d"
    },
    {
      key: "heatmap",
      display: "Heatmap",
      symbol: "map",
      showInTypeName: true,
      color: "#ff0000",
      sourceTypes: structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d, SemanticType.Translation]),
      showDocs: true,
      options: [
        {
          key: "timeRange",
          display: "Time Range",
          showInTypeName: false,
          values: [
            { key: "enabled", display: "Enabled" },
            { key: "auto", display: "Auto" },
            { key: "teleop", display: "Teleop" },
            { key: "teleop-no-endgame", display: "Teleop (No Endgame)" },
            { key: "full", display: "Full Log" },
            { key: "visible", display: "Visible Range" }
          ]
        }
      ],
      initialSelectionOption: "timeRange",
      previewType: null
    },
    {
      key: "aprilTag",
      display: "AprilTag",
      symbol: "qrcode",
      showInTypeName: true,
      color: "#000000",
      darkColor: "#ffffff",
      sourceTypes: structuredTypesFor([SemanticType.Pose3d, SemanticType.Trajectory], { trajectorySamples: false }),
      showDocs: true,
      options: [
        {
          key: "variant",
          display: "Variant",
          showInTypeName: true,
          values: []
        }
      ],
      parentKey: "aprilTag",
      initialSelectionOption: "variant",
      previewType: "Pose3d"
    },
    {
      key: "aprilTagIDs",
      display: "AprilTag IDs",
      symbol: "numbers",
      showInTypeName: true,
      color: "#000000",
      darkColor: "#ffffff",
      sourceTypes: ["NumberArray"],
      showDocs: true,
      options: [],
      childOf: "aprilTag",
      previewType: null
    },
    {
      key: "axes",
      display: "Axes",
      symbol: "explore",
      showInTypeName: true,
      color: "#000000",
      darkColor: "#ffffff",
      sourceTypes: structuredTypesFor([SemanticType.Pose3d, SemanticType.Trajectory], { trajectorySamples: false }),
      showDocs: true,
      options: [],
      previewType: "Pose3d"
    },
    {
      key: "cone",
      display: "Cone",
      symbol: "navigation",
      showInTypeName: true,
      color: "color",
      sourceTypes: structuredTypesFor([SemanticType.Pose2d, SemanticType.Pose3d, SemanticType.Trajectory], {
        trajectorySamples: false
      }),
      showDocs: true,
      options: [
        {
          key: "color",
          display: "Color",
          showInTypeName: false,
          values: NeonColors
        },
        {
          key: "position",
          display: "Position",
          showInTypeName: true,
          values: [
            { key: "center", display: "Center" },
            { key: "back", display: "Back" },
            { key: "front", display: "Front" }
          ]
        }
      ],
      initialSelectionOption: "color",
      previewType: "Pose3d"
    },
    {
      key: "cameraOverride",
      display: "Camera Override",
      symbol: "photocamera",
      showInTypeName: true,
      color: "#888888",
      sourceTypes: structuredTypesFor([SemanticType.Pose3d], { shape: "scalar" }),
      showDocs: true,
      options: [],
      previewType: "Pose3d"
    }
  ]
};

export default Field3dController_Config;
