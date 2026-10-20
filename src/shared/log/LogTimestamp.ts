// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

export type TimestampDomain =
  | { readonly kind: "log" }
  | { readonly kind: "receive" }
  | { readonly kind: "clock"; readonly id: string };

export interface DomainTimestamp {
  readonly seconds: number;
  readonly domain: TimestampDomain;
}

export interface ConvertedTimestamp {
  readonly source: DomainTimestamp;
  readonly display: DomainTimestamp;
}

export type LogTimestamp = number | DomainTimestamp | ConvertedTimestamp;

export interface ClockConversion {
  readonly from: TimestampDomain;
  readonly to: TimestampDomain;
  readonly offsetSeconds: number;
}

export const LOG_CLOCK: TimestampDomain = { kind: "log" };
export const RECEIVE_CLOCK: TimestampDomain = { kind: "receive" };

export function sameTimestampDomain(a: TimestampDomain, b: TimestampDomain): boolean {
  return a.kind === b.kind && (a.kind !== "clock" || (b.kind === "clock" && a.id === b.id));
}

export function timestampSeconds(timestamp: LogTimestamp): number {
  return typeof timestamp === "number"
    ? timestamp
    : "display" in timestamp
    ? timestamp.display.seconds
    : timestamp.seconds;
}

export function timestampSource(timestamp: LogTimestamp): DomainTimestamp | null {
  if (typeof timestamp === "number") return null;
  const source = "source" in timestamp ? timestamp.source : timestamp;
  return { seconds: source.seconds, domain: { ...source.domain } };
}

export function copyTimestamp(timestamp: LogTimestamp): LogTimestamp {
  if (typeof timestamp === "number") return timestamp;
  if ("display" in timestamp) {
    return {
      source: { seconds: timestamp.source.seconds, domain: { ...timestamp.source.domain } },
      display: { seconds: timestamp.display.seconds, domain: { ...timestamp.display.domain } }
    };
  }
  return { seconds: timestamp.seconds, domain: { ...timestamp.domain } };
}

export function resolveTimestamp(timestamp: LogTimestamp, displayClock: TimestampDomain): number {
  if (typeof timestamp !== "number") {
    const display = "display" in timestamp ? timestamp.display : timestamp;
    if (!sameTimestampDomain(display.domain, displayClock)) {
      throw new Error("Timestamp requires an explicit conversion to the display clock");
    }
  }
  return timestampSeconds(timestamp);
}

export function convertTimestamp(timestamp: DomainTimestamp, conversion: ClockConversion): ConvertedTimestamp {
  if (!sameTimestampDomain(timestamp.domain, conversion.from)) {
    throw new Error("Timestamp does not use the conversion's source clock");
  }
  return {
    source: { seconds: timestamp.seconds, domain: { ...timestamp.domain } },
    display: { seconds: timestamp.seconds + conversion.offsetSeconds, domain: { ...conversion.to } }
  };
}

export function timestampDomainLabel(domain: TimestampDomain): string {
  switch (domain.kind) {
    case "log":
      return "Log time";
    case "receive":
      return "Receive time";
    case "clock":
      return domain.id;
  }
}
