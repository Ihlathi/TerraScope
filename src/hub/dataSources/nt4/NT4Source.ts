// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { IS_LITE } from "../../../shared/buildConstants";
import Log from "../../../shared/log/Log";
import { PHOTON_PREFIX, PROTO_PREFIX, STRUCT_PREFIX, getStructuredTypeFromRaw } from "../../../shared/log/LogKeyUtils";
import { ConvertedTimestamp } from "../../../shared/log/LogTimestamp";
import { getURCLKeys } from "../../../shared/log/LogUtil";
import LoggableType from "../../../shared/log/LoggableType";
import { AUTONOMOUS_KEYS, ENABLED_KEYS, UTILITY_KEYS } from "../../../shared/log/RobotState";
import { plugins } from "../../../shared/plugins/builtins";
import { checkArrayType } from "../../../shared/util";
import { LiveDataSource, LiveDataSourceStatus } from "../LiveDataSource";
import { NT4_Client, NT4_PORTS_DEFAULT, NT4_PORTS_DS, NT4_PORTS_SYSTEMCORE, NT4_Topic } from "./NT4";
import { NT4_SERVER_CLOCK } from "./NT4Timestamp";
import NT4Tuner from "./NT4Tuner";

export const WPILOG_PREFIX = "NT:";
export const DS_PREFIX = "DS:";
export const AKIT_PREFIX = "/AdvantageKit";
export const AKIT_TUNING_PREFIX = "/Tuning";

export enum NT4Mode {
  Default,
  AdvantageKit,
  Systemcore,
  DriverStation
}

export interface NT4SourceRuntime {
  getSubscriptionMode(): "logging" | "low-bandwidth";
  getActiveFields(): string[];
  startPeriodic(callback: () => void): () => void;
  onError(message: string): void;
  ports?: number[];
}

export default class NT4Source extends LiveDataSource {
  private mode: NT4Mode;
  private client: NT4_Client | null = null;

  private shouldRunOutputCallback = false;
  private connectTime: number | null = null;
  private cancelPeriodic: (() => void) | null = null;
  private noFieldsTimeout: NodeJS.Timeout | null = null;
  private loggingSubscription: number | null = null;
  private lowBandwidthTopicSubscription: number | null = null;
  private lowBandwidthDataSubscriptions: { [id: string]: number } = {};

  constructor(
    mode: NT4Mode,
    private readonly runtime: NT4SourceRuntime
  ) {
    super();
    this.mode = mode;
  }

  private periodic() {
    // Update timestamp range based on connection time
    if (this.client !== null && this.connectTime !== null) {
      let connectServerTime = this.client.getServerTime_us(this.connectTime);
      if (connectServerTime !== null) this.log?.clearBeforeTime(connectServerTime / 1e6);
    }

    // Update subscriptions
    if (this.client !== null) {
      if (this.isRecording() || this.runtime.getSubscriptionMode() === "logging") {
        // Switch to logging subscribe mode
        Object.values(this.lowBandwidthDataSubscriptions).forEach((subscriptionId) => {
          this.client?.unsubscribe(subscriptionId);
        });
        this.lowBandwidthDataSubscriptions = {};
        if (this.lowBandwidthTopicSubscription !== null) {
          this.client.unsubscribe(this.lowBandwidthTopicSubscription);
          this.lowBandwidthTopicSubscription = null;
        }
        if (this.loggingSubscription === null) {
          this.loggingSubscription = this.client.subscribe(
            this.mode === NT4Mode.AdvantageKit ? [AKIT_PREFIX + "/", AKIT_TUNING_PREFIX + "/"] : [""],
            true,
            true,
            0.02
          );
        }
      } else {
        // Switch to low bandwidth subscribe mode
        if (this.loggingSubscription !== null) {
          this.client.unsubscribe(this.loggingSubscription);
          this.loggingSubscription = null;
        }
        if (this.lowBandwidthTopicSubscription === null) {
          this.lowBandwidthTopicSubscription = this.client.subscribeTopicsOnly(
            this.mode === NT4Mode.AdvantageKit ? [AKIT_PREFIX + "/", AKIT_TUNING_PREFIX + "/"] : [""],
            true
          );
        }

        // Add active fields
        let activeFields: Set<string> = new Set();
        if (this.log !== null) {
          let announcedKeys = this.log.getFieldKeys().filter((key) => this.log?.getType(key) !== LoggableType.Empty);
          let initialKeys: string[];
          switch (this.mode) {
            case NT4Mode.AdvantageKit:
              initialKeys = ["/.schema", "/Timestamp"];
              break;
            case NT4Mode.DriverStation:
              initialKeys = [DS_PREFIX + "/.schema"];
              break;
            default:
              initialKeys = [
                WPILOG_PREFIX + "/.schema",
                WPILOG_PREFIX + AKIT_PREFIX + "/.schema",
                WPILOG_PREFIX + AKIT_PREFIX + "/Timestamp"
              ];
              break;
          }
          [
            ...initialKeys,
            ...ENABLED_KEYS,
            ...AUTONOMOUS_KEYS,
            ...UTILITY_KEYS,
            ...this.getSourceKeys(this.runtime.getActiveFields()),
            ...getURCLKeys(this.log)
          ].forEach((key) => {
            // Compare to announced keys
            announcedKeys.forEach((announcedKey) => {
              let subscribeKey: string | null = null;
              if (announcedKey.startsWith(key)) {
                subscribeKey = key;
              } else if (key.startsWith(announcedKey)) {
                subscribeKey = announcedKey;
              }
              if (subscribeKey !== null) {
                if (this.mode === NT4Mode.AdvantageKit) {
                  if (subscribeKey.startsWith(AKIT_TUNING_PREFIX)) {
                    activeFields.add(subscribeKey);
                  } else {
                    activeFields.add(AKIT_PREFIX + subscribeKey);
                  }
                } else {
                  activeFields.add(subscribeKey.slice(this.getLogPrefix().length));
                }
              }
            });
          });
        }

        // Remove duplicates based on prefixes
        let activeFieldsCopy = new Set(activeFields);
        activeFieldsCopy.forEach((field0) => {
          activeFieldsCopy.forEach((field1) => {
            if (field0 !== field1 && field0.startsWith(field1)) {
              activeFields.delete(field0);
            }
          });
        });

        // Update subscriptions
        activeFields.forEach((field) => {
          if (this.client === null) return;
          if (!(field in this.lowBandwidthDataSubscriptions)) {
            // Prefix match required for mechanisms, joysticks, and metadata
            this.lowBandwidthDataSubscriptions[field] = this.client.subscribe([field], true, true, 0.02);
          }
        });
        Object.entries(this.lowBandwidthDataSubscriptions).forEach(([field, subscriptionId]) => {
          if (!activeFields.has(field)) {
            this.client?.unsubscribe(subscriptionId);
            delete this.lowBandwidthDataSubscriptions[field];
          }
        });
      }
    }

    // Check if output callback should be triggered (prevents
    // running the callback many times for each frame)
    if (
      !this.shouldRunOutputCallback ||
      this.status === LiveDataSourceStatus.Stopped ||
      !this.outputCallback ||
      !this.log
    )
      return;
    this.shouldRunOutputCallback = false;
    this.outputCallback(this.log, () => {
      if (this.client) {
        let liveTimestamp = this.client.getLiveTimestamp();
        if (liveTimestamp === null) {
          return 10;
        } else {
          return liveTimestamp.display.seconds;
        }
      } else {
        return 10;
      }
    });
  }

  connect(
    address: string,
    statusCallback: (status: LiveDataSourceStatus) => void,
    outputCallback: (log: Log, timeSupplier: () => number) => void
  ) {
    super.connect(address, statusCallback, outputCallback);
    this.shouldRunOutputCallback = false;

    this.log = new Log(true, NT4_SERVER_CLOCK);
    let ports: number[];
    switch (this.mode) {
      case NT4Mode.Systemcore:
        ports = NT4_PORTS_SYSTEMCORE;
        break;
      case NT4Mode.DriverStation:
        ports = NT4_PORTS_DS;
        break;
      default:
        ports = NT4_PORTS_DEFAULT;
        break;
    }
    this.client = new NT4_Client(
      address,
      this.runtime.ports ?? ports,
      IS_LITE ? "AdvantageScopeLite" : "AdvantageScope",
      (topic: NT4_Topic) => {
        // Announce
        if (!this.log) return;
        if (this.noFieldsTimeout) clearTimeout(this.noFieldsTimeout);
        if (topic.name === "") return;
        let modifiedKey = this.getKeyFromTopic(topic);
        let structuredType = getStructuredTypeFromRaw(topic.type);
        this.log.createBlankField(modifiedKey, this.getLogType(topic.type));
        this.log.setWpilibType(modifiedKey, topic.type);
        this.log.setStructuredType(modifiedKey, structuredType);
        this.log.setMetadataString(
          modifiedKey,
          Object.keys(topic.properties).length > 0 ? JSON.stringify(topic.properties) : ""
        );
        this.shouldRunOutputCallback = true;
      },
      (topic: NT4_Topic) => {
        // Unannounce
      },
      (topic: NT4_Topic) => {
        // Properties
        if (!this.log) return;
        if (topic.name === "") return;
        let modifiedKey = this.getKeyFromTopic(topic);
        this.log.setMetadataString(
          modifiedKey,
          Object.keys(topic.properties).length > 0 ? JSON.stringify(topic.properties) : ""
        );
        this.shouldRunOutputCallback = true;
      },
      (topic: NT4_Topic, timestamp_us: number, value: unknown) => {
        // Data
        if (!this.log || !this.client || topic.name === "") return;

        let key = this.getKeyFromTopic(topic);
        const timestamp: ConvertedTimestamp = {
          source: { seconds: timestamp_us / 1e6, domain: NT4_SERVER_CLOCK },
          display: {
            seconds: Math.max(timestamp_us, this.log.getTimestampRange()[0]) / 1000000,
            domain: NT4_SERVER_CLOCK
          }
        };

        let updated = false;
        switch (topic.type) {
          case "boolean":
            if (typeof value === "boolean") {
              this.log?.putBoolean(key, timestamp, value);
              updated = true;
            } else {
              console.warn('Expected a boolean value for "' + key + '" but got:', value);
            }
            break;
          case "int":
          case "float":
          case "double":
            if (typeof value === "number") {
              this.log?.putNumber(key, timestamp, value);
              updated = true;
            } else {
              console.warn('Expected a number value for "' + key + '" but got:', value);
            }
            break;
          case "string":
            if (typeof value === "string") {
              this.log?.putString(key, timestamp, value);
              updated = true;
            } else {
              console.warn('Expected a string value for "' + key + '" but got:', value);
            }
            break;
          case "boolean[]":
            if (checkArrayType(value, "boolean")) {
              this.log?.putBooleanArray(key, timestamp, value as boolean[]);
              updated = true;
            } else {
              console.warn('Expected a boolean[] value for "' + key + '" but got:', value);
            }
            break;
          case "int[]":
          case "float[]":
          case "double[]":
            if (checkArrayType(value, "number")) {
              this.log?.putNumberArray(key, timestamp, value as number[]);
              updated = true;
            } else {
              console.warn('Expected a number[] value for "' + key + '" but got:', value);
            }
            break;
          case "string[]":
            if (checkArrayType(value, "string")) {
              this.log?.putStringArray(key, timestamp, value as string[]);
              updated = true;
            } else {
              console.warn('Expected a string[] value for "' + key + '" but got:', value);
            }
            break;
          case "json":
            if (typeof value === "string") {
              this.log?.putJSON(key, timestamp, value);
              updated = true;
            } else {
              console.warn('Expected a string value for "' + key + '" but got:', value);
            }
            break;
          case "msgpack":
            if (value instanceof Uint8Array) {
              this.log?.putMsgpack(key, timestamp, value);
              updated = true;
            } else {
              console.warn('Expected a raw value for "' + key + '" but got:', value);
            }
            break;
          default: // Default to raw
            if (value instanceof Uint8Array) {
              if (topic.type.startsWith(STRUCT_PREFIX)) {
                let schemaType = topic.type.split(STRUCT_PREFIX)[1];
                if (schemaType.endsWith("[]")) {
                  this.log?.putStruct(key, timestamp, value, schemaType.slice(0, -2), true);
                } else {
                  this.log?.putStruct(key, timestamp, value, schemaType, false);
                }
              } else if (topic.type.startsWith(PHOTON_PREFIX)) {
                let schemaType = topic.type.split(PHOTON_PREFIX)[1];
                this.log?.putPhotonStruct(key, timestamp, value, schemaType);
              } else if (topic.type.startsWith(PROTO_PREFIX)) {
                let schemaType = topic.type.split(PROTO_PREFIX)[1];
                this.log?.putProto(key, timestamp, value, schemaType);
              } else {
                this.log?.putRaw(key, timestamp, value);
                const schema = plugins.getSchema(topic.type);
                if (schema !== undefined) {
                  try {
                    schema.decode(this.log, key, timestamp, value);
                  } catch {
                    console.error('Failed to decode custom schema "' + topic.type + '"');
                  }
                  this.log.setGeneratedParent(key);
                }
              }
              updated = true;
            } else {
              console.warn('Expected a raw value for "' + key + '" but got:', value);
            }
            break;
        }
        if (updated) {
          this.shouldRunOutputCallback = true;
        }
      },
      () => {
        // Connected
        this.setStatus(LiveDataSourceStatus.Active);
        this.log = new Log(true, NT4_SERVER_CLOCK);
        this.shouldRunOutputCallback = true;
        if (!this.connectTime && this.client !== null) {
          this.connectTime = this.client.getClientTime_us();
        }
        if (this.mode === NT4Mode.AdvantageKit) {
          this.noFieldsTimeout = setTimeout(() => {
            this.runtime.onError(
              "No fields were received from the server. AdvantageKit mode is selected. Are you connecting to a server without AdvantageKit?"
            );
          }, 5000);
        }
      },
      () => {
        // Disconnected
        this.setStatus(LiveDataSourceStatus.Connecting);
        this.shouldRunOutputCallback = false;
        this.connectTime = null;
        if (this.noFieldsTimeout) clearTimeout(this.noFieldsTimeout);
      }
    );

    // Start connection
    this.cancelPeriodic = this.runtime.startPeriodic(() => this.periodic());
    this.client.connect();
  }

  stop() {
    super.stop();
    this.client?.disconnect();
    this.cancelPeriodic?.();
    this.cancelPeriodic = null;
    if (this.noFieldsTimeout !== null) clearTimeout(this.noFieldsTimeout);
  }

  getTime(): number | null {
    return this.client?.getLiveTimestamp()?.display.seconds ?? null;
  }

  getTuner() {
    if (this.client === null || this.log === null) {
      throw "Cannot create NT4 tuner before starting connection";
    } else {
      return new NT4Tuner(this.client, this.mode, () => this.log!);
    }
  }

  private getLogPrefix(): string {
    return this.mode === NT4Mode.DriverStation ? DS_PREFIX : WPILOG_PREFIX;
  }

  /** Gets the name of the topic, depending on whether we're running in AdvantageKit mode. */
  private getKeyFromTopic(topic: NT4_Topic): string {
    if (this.mode === NT4Mode.AdvantageKit) {
      if (topic.name.startsWith(AKIT_PREFIX)) {
        return topic.name.slice(AKIT_PREFIX.length);
      } else {
        return topic.name;
      }
    } else {
      return this.getLogPrefix() + topic.name;
    }
  }

  private getLogType(ntType: string): LoggableType {
    switch (ntType) {
      case "boolean":
        return LoggableType.Boolean;
      case "int":
      case "float":
      case "double":
        return LoggableType.Number;
      case "string":
      case "json":
        return LoggableType.String;
      case "boolean[]":
        return LoggableType.BooleanArray;
      case "int[]":
      case "float[]":
      case "double[]":
        return LoggableType.NumberArray;
      case "string[]":
        return LoggableType.StringArray;
      default: // Default to raw
        return LoggableType.Raw;
    }
  }
}
