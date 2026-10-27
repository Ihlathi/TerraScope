// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import LogField from "./LogField";
import { ClockConversion, DomainTimestamp, sameTimestampDomain, TimestampDomain } from "./LogTimestamp";

export function sourceClock(namespace: string, domain: TimestampDomain): TimestampDomain {
  return { kind: "clock", id: namespace.slice(1) + "/" + (domain.kind === "clock" ? domain.id : domain.kind) };
}

export default class ProjectedLogField extends LogField {
  private timestampCache?: { revision: number; offsetSeconds: number; timestamps: number[] };

  constructor(
    private source: LogField,
    private sourceDisplayClock: TimestampDomain,
    private namespace: string,
    private conversion: ClockConversion
  ) {
    super(source.getType());
    this.structuredType = source.structuredType;
    this.wpilibType = source.wpilibType;
    this.metadataString = source.metadataString;
    this.typeWarning = source.typeWarning;
  }

  canReuse(
    source: LogField,
    sourceDisplayClock: TimestampDomain,
    namespace: string,
    conversion: ClockConversion
  ): boolean {
    return (
      this.source === source &&
      sameTimestampDomain(this.sourceDisplayClock, sourceDisplayClock) &&
      this.namespace === namespace &&
      this.conversion.offsetSeconds === conversion.offsetSeconds &&
      sameTimestampDomain(this.conversion.from, conversion.from) &&
      sameTimestampDomain(this.conversion.to, conversion.to) &&
      this.structuredType === source.structuredType &&
      this.wpilibType === source.wpilibType &&
      this.metadataString === source.metadataString &&
      this.typeWarning === source.typeWarning
    );
  }

  hasOnlyAppendedOrTrimmedSince(revision: number): boolean {
    return this.source.hasOnlyAppendedOrTrimmedSince(revision);
  }

  getTimestampCount(): number {
    return this.source.getTimestampCount();
  }

  getTimestampAt(index: number): number | undefined {
    const time = this.source.getTimestampAt(index);
    return time === undefined ? undefined : time + this.conversion.offsetSeconds;
  }

  getRevision(): number {
    return this.source.getRevision();
  }

  getHistoryState() {
    const state = this.source.getHistoryState();
    return {
      ...state,
      offsetSeconds: state.offsetSeconds + this.conversion.offsetSeconds,
      trimmedBefore: state.trimmedBefore === null ? null : state.trimmedBefore + this.conversion.offsetSeconds
    };
  }

  getTimestamp(index: number): number | undefined {
    const time = this.source.getTimestamp(index);
    return time === undefined ? undefined : time + this.conversion.offsetSeconds;
  }

  getTimestamps(): number[] {
    const revision = this.source.getRevision();
    const offsetSeconds = this.conversion.offsetSeconds;
    if (this.timestampCache?.revision !== revision || this.timestampCache.offsetSeconds !== offsetSeconds) {
      this.timestampCache = {
        revision,
        offsetSeconds,
        timestamps: this.source.getTimestamps().map((time) => time + offsetSeconds)
      };
    }
    return this.timestampCache.timestamps;
  }

  getRange(start: number, end: number, uuid?: string, startOffset?: number) {
    const range = this.source.getRange(
      start - this.conversion.offsetSeconds,
      end - this.conversion.offsetSeconds,
      uuid,
      startOffset
    );
    return { timestamps: range.timestamps.map((time) => time + this.conversion.offsetSeconds), values: range.values };
  }

  getTimestampSources(start: number, end: number): DomainTimestamp[] {
    return this.source
      .getTimestampSources(
        start - this.conversion.offsetSeconds,
        end - this.conversion.offsetSeconds,
        this.sourceDisplayClock
      )
      .map((stamp) => ({ seconds: stamp.seconds, domain: sourceClock(this.namespace, stamp.domain) }));
  }

  getStripingReference(): boolean {
    return this.source.getStripingReference();
  }

  toSerialized() {
    return {
      ...this.source.toSerialized(),
      timestamps: this.getTimestamps(),
      sourceTimestamps: this.getTimestampSources(-Infinity, Infinity)
    };
  }
}
