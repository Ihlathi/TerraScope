// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Semantic kinds for structured log fields. WPILib struct names and the
 * AdvantageKit / Choreo structs recorded with the same names map onto these
 * kinds. Layout-specific reads stay in geometry.ts.
 */
export const SemanticType = {
  Pose2d: "pose2d",
  Pose3d: "pose3d",
  Translation: "translation",
  Rotation: "rotation",
  Trajectory: "trajectory",
  MechanismJoint: "mechanismJoint",
  NumericSeries: "numericSeries"
} as const;

export type SemanticType = (typeof SemanticType)[keyof typeof SemanticType];

type StructuredTypeEntry = {
  logType: string;
  semantic: SemanticType;
  array: boolean;
};

/** Ordered so filtered lists match the field, mechanism, and swerve source lists. */
const STRUCTURED_TYPES: readonly StructuredTypeEntry[] = [
  { logType: "Pose2d", semantic: SemanticType.Pose2d, array: false },
  { logType: "Pose3d", semantic: SemanticType.Pose3d, array: false },
  { logType: "Pose2d[]", semantic: SemanticType.Pose2d, array: true },
  { logType: "Pose3d[]", semantic: SemanticType.Pose3d, array: true },
  { logType: "Transform2d", semantic: SemanticType.Pose2d, array: false },
  { logType: "Transform3d", semantic: SemanticType.Pose3d, array: false },
  { logType: "Transform2d[]", semantic: SemanticType.Pose2d, array: true },
  { logType: "Transform3d[]", semantic: SemanticType.Pose3d, array: true },
  { logType: "Translation2d", semantic: SemanticType.Translation, array: false },
  { logType: "Translation3d", semantic: SemanticType.Translation, array: false },
  { logType: "Translation2d[]", semantic: SemanticType.Translation, array: true },
  { logType: "Translation3d[]", semantic: SemanticType.Translation, array: true },
  { logType: "Rotation2d", semantic: SemanticType.Rotation, array: false },
  { logType: "Rotation3d", semantic: SemanticType.Rotation, array: false },
  { logType: "Rotation2d[]", semantic: SemanticType.Rotation, array: true },
  { logType: "Rotation3d[]", semantic: SemanticType.Rotation, array: true },
  { logType: "Trajectory", semantic: SemanticType.Trajectory, array: false },
  { logType: "DifferentialSample[]", semantic: SemanticType.Trajectory, array: true },
  { logType: "SwerveSample[]", semantic: SemanticType.Trajectory, array: true },
  { logType: "Mechanism2d", semantic: SemanticType.MechanismJoint, array: false },
  { logType: "Number", semantic: SemanticType.NumericSeries, array: false }
];

const BY_LOG_TYPE = new Map(STRUCTURED_TYPES.map((entry) => [entry.logType, entry.semantic]));

/** Photon vision target corners. Not a semantic kind, but still drawn as poses. */
const LEGACY_SPATIAL_LOG_TYPES = new Set(["TargetCorner:16f6ac0dedc8eaccb951f4895d9e18b6[]"]);

export type StructuredTypeFilter = {
  shape?: "all" | "array" | "scalar";
  /** Keep names containing "2d" or "3d". Names with neither, such as Trajectory, are kept. */
  dimension?: 2 | 3;
  /** When false, omit Choreo *Sample[] trajectory structs. Defaults to true. */
  trajectorySamples?: boolean;
};

/** Maps a WPILib or AdvantageKit structured type string onto a semantic kind. */
export function classifyStructuredType(logType: string): SemanticType | null {
  return BY_LOG_TYPE.get(logType) ?? null;
}

/** Log type strings for the given kinds, in registry order. */
export function structuredTypesFor(semantics: readonly SemanticType[], filter: StructuredTypeFilter = {}): string[] {
  const shape = filter.shape ?? "all";
  const trajectorySamples = filter.trajectorySamples ?? true;
  const wanted = new Set(semantics);
  return STRUCTURED_TYPES.filter((entry) => {
    if (!wanted.has(entry.semantic)) return false;
    if (shape === "array" && !entry.array) return false;
    if (shape === "scalar" && entry.array) return false;
    if (filter.dimension === 2 && entry.logType.includes("3d")) return false;
    if (filter.dimension === 3 && entry.logType.includes("2d")) return false;
    if (!trajectorySamples && (entry.logType === "DifferentialSample[]" || entry.logType === "SwerveSample[]")) {
      return false;
    }
    return true;
  }).map((entry) => entry.logType);
}

/** True when the field or swerve pose reader knows how to draw this log type. */
export function canReadAsPose(logType: string): boolean {
  if (LEGACY_SPATIAL_LOG_TYPES.has(logType)) return true;
  const semantic = classifyStructuredType(logType);
  return semantic !== null && semantic !== SemanticType.MechanismJoint;
}
