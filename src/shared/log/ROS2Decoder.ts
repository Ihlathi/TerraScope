// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { parse } from "@foxglove/rosmsg";
import { ros2humble } from "@foxglove/rosmsg-msgs-common";
import { MessageReader } from "@foxglove/rosmsg2-serialization";
import Log from "./Log";

export default class ROS2Decoder {
  private reader: MessageReader | null;

  constructor(type: string, definition?: string) {
    const name = type.replace("/msg/", "/");
    if (definition !== undefined) {
      const definitions = parse(definition, { ros2: true });
      definitions[0].name = name;
      this.reader = new MessageReader(definitions);
    } else {
      const definitions = Object.values(ros2humble);
      const root = definitions.find((item) => item.name === name);
      this.reader =
        root === undefined ? null : new MessageReader([root, ...definitions.filter((item) => item !== root)]);
    }
  }

  write(log: Log, key: string, timestamp: number, data: Uint8Array) {
    log.putRaw(key, timestamp, data);
    if (this.reader === null) return;
    const value = this.reader.readMessage(data);
    log.setGeneratedParent(key);
    log.putUnknownStruct(key, timestamp, logValue(value));
  }
}

function logValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
    return Array.from(value as unknown as ArrayLike<unknown>, logValue);
  }
  if (Array.isArray(value)) return value.map(logValue);
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, logValue(child)]));
  }
  return value;
}
