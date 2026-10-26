// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import LoggableType from "../log/LoggableType";

interface SampleBase {
  readonly key: string;
  readonly timestamp: number;
}

interface FieldDescription {
  readonly wpilibType: string | null;
  readonly metadata: string;
}

type SampleValue =
  | { readonly type: LoggableType.Raw; readonly value: Uint8Array }
  | { readonly type: LoggableType.Boolean; readonly value: boolean }
  | { readonly type: LoggableType.Number; readonly value: number }
  | { readonly type: LoggableType.String; readonly value: string }
  | { readonly type: LoggableType.BooleanArray; readonly value: boolean[] }
  | { readonly type: LoggableType.NumberArray; readonly value: number[] }
  | { readonly type: LoggableType.StringArray; readonly value: string[] };

export type RecordingSample = SampleBase & SampleValue & FieldDescription;

export type RecordingWriteSample = SampleBase &
  SampleValue &
  (FieldDescription | { readonly wpilibType?: never; readonly metadata?: never });

interface RecordingProgress {
  readonly path: string;
  readonly bytesWritten: number;
}

export type RecordingStatus = RecordingProgress &
  (
    | { readonly kind: "idle" }
    | { readonly kind: "starting" }
    | { readonly kind: "recording" }
    | { readonly kind: "stopping" }
    | { readonly kind: "stopped"; readonly reason: "manual" | "low-disk"; readonly message: string }
    | { readonly kind: "error"; readonly message: string }
  );

export interface RecordingWriter {
  start(): Promise<void>;
  write(samples: readonly RecordingWriteSample[]): Promise<void>;
  stop(): Promise<void>;
  getStatus(): RecordingStatus;
}

export function recordingSampleSize(sample: RecordingWriteSample): number {
  const value = sample.value;
  const valueBytes =
    typeof value === "string"
      ? value.length * 3
      : value instanceof Uint8Array
      ? value.byteLength
      : Array.isArray(value)
      ? value.reduce<number>((size, item) => size + (typeof item === "string" ? item.length * 3 + 4 : 8), 0)
      : 8;
  return (
    128 + sample.key.length * 3 + (sample.wpilibType?.length ?? 0) * 3 + (sample.metadata?.length ?? 0) * 3 + valueBytes
  );
}
