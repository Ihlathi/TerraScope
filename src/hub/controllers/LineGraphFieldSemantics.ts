// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { GraphColors } from "../../shared/Colors";
import { SourceListItemState } from "../../shared/SourceListConfig";
import Log from "../../shared/log/Log";
import { Units } from "../../shared/units";

export type EnumDomain = { values: (string | number)[] };

export function detectEnum(values: readonly unknown[]): EnumDomain | null {
  const states = new Set<string | number>();
  let valueType: string | undefined;
  for (const value of values) {
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isSafeInteger(value))) return null;
    if (valueType !== undefined && typeof value !== valueType) return null;
    valueType = typeof value;
    states.add(value);
    if (states.size > GraphColors.length) return null;
  }
  return states.size === 0 ? null : { values: [...states] };
}

export function getNumericSourceUnit(log: Log, item: SourceListItemState): string | null {
  const unit = log.getUnit(item.logKey);
  if (unit !== null) return unit;
  const declared = item.options.sourceUnit;
  return Object.hasOwn(Units.ALL_UNITS, declared) ? declared : null;
}
