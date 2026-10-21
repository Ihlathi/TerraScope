// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";
import LoggableType from "../../../shared/log/LoggableType";
import LiveDataTuner from "../LiveDataTuner";
import { NT4_Client } from "./NT4";
import { AKIT_PREFIX, AKIT_TUNING_PREFIX, NT4Mode, WPILOG_PREFIX } from "./NT4Source";
import { NT4_SERVER_CLOCK } from "./NT4Timestamp";

export default class NT4Tuner implements LiveDataTuner {
  private client: NT4_Client;
  private mode: NT4Mode;

  constructor(
    client: NT4_Client,
    mode: NT4Mode,
    private getLog: () => Log
  ) {
    this.client = client;
    this.mode = mode;
  }

  hasTunableFields(): boolean {
    switch (this.mode) {
      case NT4Mode.Default:
        return true;
      case NT4Mode.AdvantageKit:
        return !this.getLog()
          .getFieldKeys()
          .every((key) => !key.startsWith(AKIT_TUNING_PREFIX));
      case NT4Mode.Systemcore:
      case NT4Mode.DriverStation:
        return false;
    }
  }

  isTunable(key: string): boolean {
    const remoteKey = this.getRemoteKey(key);
    const type = this.getLog().getType(key);
    if (
      (type !== LoggableType.Number && type !== LoggableType.Boolean) ||
      remoteKey.startsWith(AKIT_PREFIX) ||
      (this.getLog().getField("NT:/Robot/DogLog/Options") !== null && remoteKey.startsWith("/Robot")) ||
      this.getLog().isGenerated(key)
    ) {
      return false;
    }

    // If tuning is not separately disallowed, check for "mutable" metadata field
    const metadata = this.getLog().getMetadataString(key);
    if (metadata !== "") {
      try {
        const parsed = JSON.parse(metadata);
        if (typeof parsed === "object" && parsed !== null && typeof parsed.mutable === "boolean") {
          return parsed.mutable;
        }
      } catch {}
    }
    return true;
  }

  publish(key: string, value: number | boolean): void {
    if (!this.isTunable(key)) return;
    const remoteKey = this.getRemoteKey(key);
    const type = this.getLog().getWpilibType(key);
    if (type === null) return;
    this.client.publishTopic(remoteKey, type);
    let timestamp = this.client.getServerTime_us();
    if (timestamp !== null) {
      if (typeof value === "number") {
        let cleanValue = type.startsWith("int") ? Math.floor(value) : value;
        this.client.addTimestampedSample(remoteKey, timestamp, cleanValue);
        this.getLog().putNumber(key, { seconds: timestamp / 1e6, domain: NT4_SERVER_CLOCK }, cleanValue);
      } else {
        this.client.addTimestampedSample(remoteKey, timestamp, value);
        this.getLog().putBoolean(key, { seconds: timestamp / 1e6, domain: NT4_SERVER_CLOCK }, value);
      }
    }
  }

  unpublish(key: string): void {
    const remoteKey = this.getRemoteKey(key);
    this.client.unpublishTopic(remoteKey);
  }

  private getRemoteKey(key: string): string {
    if (this.mode === NT4Mode.AdvantageKit) {
      if (key.startsWith(AKIT_TUNING_PREFIX)) {
        return key;
      } else {
        return AKIT_PREFIX + key;
      }
    } else {
      return key.slice(WPILOG_PREFIX.length);
    }
  }
}
