// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import LoggableType from "./LoggableType";
import { isChildLog } from "./LogKeyUtils";
import { DomainTimestamp, LogTimestamp, TimestampDomain, timestampSeconds, timestampSource } from "./LogTimestamp";
import { logValuesEqual } from "./LogUtil";
import {
  LogValueSetAny,
  LogValueSetBoolean,
  LogValueSetBooleanArray,
  LogValueSetNumber,
  LogValueSetNumberArray,
  LogValueSetRaw,
  LogValueSetString,
  LogValueSetStringArray
} from "./LogValueSets";

/** A full log field that contains data. */
export default class LogField {
  private revision = 0;
  private rewriteRevision = 0;
  private removedCount = 0;
  private trimRevision = 0;
  private trimmedBefore: number | null = null;
  private type: LoggableType;
  private data: LogValueSetAny = { timestamps: [], values: [] };
  private sourceTimestamps: (DomainTimestamp | null)[] | undefined;
  public structuredType: string | null = null;
  public wpilibType: string | null = null; // Original type from WPILOG & NT4
  public metadataString = "";
  public typeWarning = false; // Flag that there was an attempt to write a conflicting type

  // Toggles when first value is removed, useful for creating striping effects that persist as data is updated
  private stripingReference = false;

  private getRangeCache: { [id: string]: number } = {};

  constructor(
    type: LoggableType,
    private onSample?: (timestamp: LogTimestamp, value: unknown) => void
  ) {
    this.type = type;
  }

  setSampleListener(listener: (timestamp: LogTimestamp, value: unknown) => void) {
    this.onSample = listener;
  }

  getRevision(): number {
    return this.revision;
  }

  getHistoryState(): {
    source: LogField;
    offsetSeconds: number;
    revision: number;
    rewriteRevision: number;
    count: number;
    removedCount: number;
    trimRevision: number;
    trimmedBefore: number | null;
  } {
    return {
      source: this,
      offsetSeconds: 0,
      revision: this.revision,
      rewriteRevision: this.rewriteRevision,
      count: this.data.timestamps.length,
      removedCount: this.removedCount,
      trimRevision: this.trimRevision,
      trimmedBefore: this.trimmedBefore
    };
  }

  getTimestamp(index: number): number | undefined {
    return this.data.timestamps[index];
  }

  /** Returns the constant field type. */
  getType(): LoggableType {
    return this.type;
  }

  /** Returns the value of the striping reference. */
  getStripingReference(): boolean {
    return this.stripingReference;
  }

  /** Returns the full set of ordered timestamps. */
  getTimestamps(): number[] {
    return this.data.timestamps;
  }

  getTimestampSources(start: number, end: number, displayClock: TimestampDomain): DomainTimestamp[] {
    const [first, last] = this.getRangeIndices(start, end);
    return this.data.timestamps.slice(first, last).map((seconds, index) => {
      const source = this.sourceTimestamps?.[first + index];
      return source === undefined || source === null
        ? { seconds, domain: { ...displayClock } }
        : { seconds: source.seconds, domain: { ...source.domain } };
    });
  }

  /** Clears all data before the provided timestamp. */
  clearBeforeTime(clearTimestamp: number) {
    if (this.data.timestamps.length === 0 || !(this.data.timestamps[0] < clearTimestamp)) return;
    this.revision++;
    this.trimmedBefore = clearTimestamp;
    this.trimRevision++;
    for (let i = 0; i < this.data.timestamps.length; i++) {
      // If there is more than 1 timestamps and if it occurs before the given timestamp, remove it
      if (this.data.timestamps.length >= 2 && this.data.timestamps[i + 1] < clearTimestamp) {
        this.stripingReference = !this.stripingReference;
        continue;
      }

      this.removedCount += i;
      this.data.timestamps.splice(0, i);
      this.data.values.splice(0, i);
      this.sourceTimestamps?.splice(0, i);
      break;
    }

    // If there are any left over timestamps, reassign the first timestamp to the given timestamp
    if (this.data.timestamps.length > 0 && this.data.timestamps[0] < clearTimestamp) {
      this.data.timestamps[0] = clearTimestamp;
    }
  }

  private getRangeIndices(start: number, end: number, uuid?: string, startOffset?: number): [number, number] {
    let cacheIndex: number | null = null;
    if (start === end && uuid !== undefined && uuid in this.getRangeCache) {
      cacheIndex = this.getRangeCache[uuid];
    }

    const findIndex = (timestamp: number, inclusive: boolean, low: number): number => {
      let high = this.data.timestamps.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (inclusive ? this.data.timestamps[mid] >= timestamp : this.data.timestamps[mid] > timestamp) high = mid;
        else low = mid + 1;
      }
      return low;
    };
    const cachedIndex = cacheIndex ?? -1;
    const canUseCache = cachedIndex >= 0 && cachedIndex < this.data.timestamps.length;
    let startValueIndex = findIndex(
      start,
      false,
      canUseCache && this.data.timestamps[cachedIndex] <= start ? cachedIndex : 0
    );
    startValueIndex = startValueIndex === 0 ? 0 : startValueIndex - 1;
    if (this.data.timestamps.length === 0) startValueIndex = -1;
    if (startOffset !== undefined && startOffset >= -startValueIndex) {
      startValueIndex += startOffset;
    }
    const endValueIndex = findIndex(
      end,
      true,
      canUseCache && this.data.timestamps[cachedIndex] < end ? cachedIndex : 0
    );
    const endIndex = Math.min(endValueIndex + 1, this.data.timestamps.length);

    if (start === end && uuid !== undefined) {
      this.getRangeCache[uuid] = startValueIndex;
    }

    return [startValueIndex, endIndex];
  }

  /** Returns the values in the specified timestamp range.
   *
   * If a UUID is provided, requests for single timestamps will cache
   * the timestamp index to make searches of chronological data faster.
   */
  getRange(start: number, end: number, uuid?: string, startOffset?: number): LogValueSetAny {
    const [first, last] = this.getRangeIndices(start, end, uuid, startOffset);
    return { timestamps: this.data.timestamps.slice(first, last), values: this.data.values.slice(first, last) };
  }

  /** Reads a set of Raw values from the field. */
  getRaw(start: number, end: number, uuid?: string, startOffset?: number): LogValueSetRaw | undefined {
    if (this.type === LoggableType.Raw) return this.getRange(start, end, uuid, startOffset);
  }

  /** Reads a set of Boolean values from the field. */
  getBoolean(start: number, end: number, uuid?: string, startOffset?: number): LogValueSetBoolean | undefined {
    if (this.type === LoggableType.Boolean) return this.getRange(start, end, uuid, startOffset);
  }

  /** Reads a set of Number values from the field. */
  getNumber(start: number, end: number, uuid?: string, startOffset?: number): LogValueSetNumber | undefined {
    if (this.type === LoggableType.Number) return this.getRange(start, end, uuid, startOffset);
  }

  /** Reads a set of String values from the field. */
  getString(start: number, end: number, uuid?: string, startOffset?: number): LogValueSetString | undefined {
    if (this.type === LoggableType.String) return this.getRange(start, end, uuid, startOffset);
  }

  /** Reads a set of BooleanArray values from the field. */
  getBooleanArray(
    start: number,
    end: number,
    uuid?: string,
    startOffset?: number
  ): LogValueSetBooleanArray | undefined {
    if (this.type === LoggableType.BooleanArray) return this.getRange(start, end, uuid, startOffset);
  }

  /** Reads a set of NumberArray values from the field. */
  getNumberArray(start: number, end: number, uuid?: string, startOffset?: number): LogValueSetNumberArray | undefined {
    if (this.type === LoggableType.NumberArray) return this.getRange(start, end, uuid, startOffset);
  }

  /** Reads a set of StringArray values from the field. */
  getStringArray(start: number, end: number, uuid?: string, startOffset?: number): LogValueSetStringArray | undefined {
    if (this.type === LoggableType.StringArray) return this.getRange(start, end, uuid, startOffset);
  }

  /** Inserts a new value at the correct index. */
  private putData(time: LogTimestamp, value: any) {
    const timestamp = timestampSeconds(time);
    const source = timestampSource(time);
    if (value === null) return;
    this.revision++;
    if (this.data.timestamps.length > 0 && timestamp <= this.data.timestamps[this.data.timestamps.length - 1]) {
      this.rewriteRevision++;
    }
    this.onSample?.(time, value);
    if (source !== null && this.sourceTimestamps === undefined) {
      this.sourceTimestamps = this.data.timestamps.map(() => null);
    }

    // Find position to insert based on timestamp
    let insertIndex: number;
    if (this.data.timestamps.length > 0 && timestamp > this.data.timestamps[this.data.timestamps.length - 1]) {
      // There's a good chance this data is at the end of the log, so check that first
      insertIndex = this.data.timestamps.length;
    } else {
      // Adding in the middle, find where to insert it
      let alreadyExists = false;
      insertIndex =
        this.data.timestamps.findLastIndex((x) => {
          if (alreadyExists) return;
          if (x === timestamp) alreadyExists = true;
          return x < timestamp;
        }) + 1;
      if (alreadyExists) {
        const index = this.data.timestamps.indexOf(timestamp);
        this.data.values[index] = value;
        if (this.sourceTimestamps !== undefined) this.sourceTimestamps[index] = source;
        return;
      }
    }

    // Compare to adjacent values
    let childLog = isChildLog(this.wpilibType, this.structuredType);
    if (!childLog && insertIndex > 0 && logValuesEqual(this.type, value, this.data.values[insertIndex - 1])) {
      // Same as the previous value
    } else if (
      !childLog &&
      insertIndex < this.data.values.length &&
      logValuesEqual(this.type, value, this.data.values[insertIndex])
    ) {
      // Same as the next value
      this.data.timestamps[insertIndex] = timestamp;
      if (this.sourceTimestamps !== undefined) this.sourceTimestamps[insertIndex] = source;
    } else {
      // New value
      this.data.timestamps.splice(insertIndex, 0, timestamp);
      this.data.values.splice(insertIndex, 0, value);
      this.sourceTimestamps?.splice(insertIndex, 0, source);
    }
  }

  /** Writes a new Raw value to the field. */
  putRaw(timestamp: LogTimestamp, value: Uint8Array) {
    if (this.type === LoggableType.Raw) {
      this.putData(timestamp, value);
    } else this.typeWarning = true;
  }

  /** Writes a new Boolean value to the field. */
  putBoolean(timestamp: LogTimestamp, value: boolean) {
    if (this.type === LoggableType.Boolean) {
      this.putData(timestamp, value);
    } else this.typeWarning = true;
  }

  /** Writes a new Number value to the field. */
  putNumber(timestamp: LogTimestamp, value: number) {
    if (this.type === LoggableType.Number) {
      this.putData(timestamp, value);
    } else this.typeWarning = true;
  }

  /** Writes a new String value to the field. */
  putString(timestamp: LogTimestamp, value: string) {
    if (this.type === LoggableType.String) {
      this.putData(timestamp, value);
    } else this.typeWarning = true;
  }

  /** Writes a new BooleanArray value to the field. */
  putBooleanArray(timestamp: LogTimestamp, value: boolean[]) {
    if (this.type === LoggableType.BooleanArray) {
      this.putData(timestamp, value);
    } else this.typeWarning = true;
  }

  /** Writes a new NumberArray value to the field. */
  putNumberArray(timestamp: LogTimestamp, value: number[]) {
    if (this.type === LoggableType.NumberArray) {
      this.putData(timestamp, value);
    } else this.typeWarning = true;
  }

  /** Writes a new StringArray value to the field. */
  putStringArray(timestamp: LogTimestamp, value: string[]) {
    if (this.type === LoggableType.StringArray) {
      this.putData(timestamp, value);
    } else this.typeWarning = true;
  }

  /** Returns a serialized version of the data from this field. */
  toSerialized(): any {
    return {
      type: this.type,
      timestamps: this.data.timestamps,
      values: this.data.values,
      ...(this.sourceTimestamps === undefined ? {} : { sourceTimestamps: this.sourceTimestamps }),
      structuredType: this.structuredType,
      wpilibType: this.wpilibType,
      metadataString: this.metadataString,
      stripingReference: this.stripingReference,
      typeWarning: this.typeWarning
    };
  }

  /** Creates a new field based on the data from `toSerialized()` */
  static fromSerialized(serializedData: any) {
    let field = new LogField(serializedData.type);
    field.data = {
      timestamps: serializedData.timestamps,
      values: serializedData.values
    };
    field.sourceTimestamps = serializedData.sourceTimestamps?.map((source: DomainTimestamp | null) =>
      source === null ? null : { seconds: source.seconds, domain: { ...source.domain } }
    );
    field.structuredType = serializedData.structuredType;
    field.wpilibType = serializedData.wpilibType;
    field.metadataString = serializedData.metadataString;
    field.stripingReference = serializedData.stripingReference;
    field.typeWarning = serializedData.typeWarning;
    return field;
  }
}
