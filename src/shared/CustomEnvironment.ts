// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Field select value for a user-sized environment, not an FRC or FTC asset. */
export const CUSTOM_FIELD_ID = "custom";

/** Long edge of the blank 2D field, in pixels. The short edge follows the aspect ratio. */
export const CUSTOM_FIELD_LONG_EDGE_PX = 1000;

export type CustomEnvironment = {
  /** Extent along X, in meters. */
  lengthMeters: number;
  /** Extent along Y, in meters. */
  widthMeters: number;
  /** World X of the minimum corner, in meters. */
  originXMeters: number;
  /** World Y of the minimum corner, in meters. */
  originYMeters: number;
};

export const DEFAULT_CUSTOM_ENVIRONMENT: CustomEnvironment = {
  lengthMeters: 10,
  widthMeters: 6,
  originXMeters: 0,
  originYMeters: 0
};

export type SceneBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
};

/** Accepts a finite origin and a positive length and width. */
export function parseCustomEnvironment(
  lengthMeters: number,
  widthMeters: number,
  originXMeters: number,
  originYMeters: number
): CustomEnvironment | null {
  if (!Number.isFinite(lengthMeters) || !Number.isFinite(widthMeters)) return null;
  if (!Number.isFinite(originXMeters) || !Number.isFinite(originYMeters)) return null;
  if (lengthMeters <= 0 || widthMeters <= 0) return null;
  return { lengthMeters, widthMeters, originXMeters, originYMeters };
}

/** Rectangle covered by the environment. The origin is the minimum corner. */
export function sceneBounds(env: CustomEnvironment): SceneBounds {
  return {
    minX: env.originXMeters,
    minY: env.originYMeters,
    maxX: env.originXMeters + env.lengthMeters,
    maxY: env.originYMeters + env.widthMeters,
    centerX: env.originXMeters + env.lengthMeters / 2,
    centerY: env.originYMeters + env.widthMeters / 2
  };
}

/** Position inside the rectangle, from the origin corner. 0 and 1 are the edges. */
export function normalizedOnScene(env: CustomEnvironment, x: number, y: number): { u: number; v: number } {
  return {
    u: (x - env.originXMeters) / env.lengthMeters,
    v: (y - env.originYMeters) / env.widthMeters
  };
}

/**
 * User-frame translation into the center-origin frame used by the 2D field renderer.
 * The center of the rectangle becomes (0, 0).
 */
export function toCenterFrame(env: CustomEnvironment, translation: readonly [number, number]): [number, number] {
  const bounds = sceneBounds(env);
  return [translation[0] - bounds.centerX, translation[1] - bounds.centerY];
}

/** Inches matching Units.convert(..., "meters", "inches"), so bundled field configs stay comparable. */
export function customFieldInches(env: CustomEnvironment): { widthInches: number; heightInches: number } {
  return {
    widthInches: env.lengthMeters / 0.0254,
    heightInches: env.widthMeters / 0.0254
  };
}

export function customFieldPixels(env: CustomEnvironment): { width: number; height: number } {
  return {
    width: CUSTOM_FIELD_LONG_EDGE_PX,
    height: Math.max(1, Math.round(CUSTOM_FIELD_LONG_EDGE_PX * (env.widthMeters / env.lengthMeters)))
  };
}

export function customFieldKey(env: CustomEnvironment, assetUrl: string): string {
  return `custom:${env.lengthMeters}:${env.widthMeters}:${env.originXMeters}:${env.originYMeters}:${assetUrl}`;
}
