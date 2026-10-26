// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import LogField from "./LogField";
import { ClockConversion, DomainTimestamp, TimestampDomain } from "./LogTimestamp";

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

  getRevision(): number {
    return this.source.getRevision();
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
