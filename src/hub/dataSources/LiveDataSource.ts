// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../shared/log/Log";
import { isSchema } from "../../shared/log/LogKeyUtils";
import LoggableType from "../../shared/log/LoggableType";
import { RecordingSample } from "../../shared/recording/RecordingWriter";
import { createUUID } from "../../shared/util";
import LiveDataTuner from "./LiveDataTuner";

/** A provider of live log data (i.e. the data is updated as it is received). */
export abstract class LiveDataSource {
  protected UUID: string = createUUID();
  protected status: LiveDataSourceStatus = LiveDataSourceStatus.Waiting;
  private sourceLog: Log | null = null;
  private recordingListener: ((sample: RecordingSample) => void) | null = null;
  private removeRecordingListener: (() => void) | null = null;

  protected get log(): Log | null {
    return this.sourceLog;
  }

  protected set log(log: Log | null) {
    if (this.sourceLog === log) return;
    this.removeRecordingListener?.();
    this.removeRecordingListener = null;
    this.sourceLog = log;
    this.observeRecording();
  }

  setRecordingListener(listener: ((sample: RecordingSample) => void) | null) {
    this.removeRecordingListener?.();
    this.removeRecordingListener = null;
    this.recordingListener = listener;
    this.observeRecording();
  }

  isRecording(): boolean {
    return this.recordingListener !== null;
  }

  private observeRecording() {
    const log = this.sourceLog;
    const listener = this.recordingListener;
    if (log === null || listener === null) return;
    this.removeRecordingListener = log.addSampleListener(listener);
    for (const key of log.getFieldKeys().filter(isSchema)) {
      if (this.recordingListener !== listener) break;
      const range = log.getRaw(key, -Infinity, Infinity);
      if (range === undefined || range.values.length === 0) continue;
      const index = range.values.length - 1;
      listener({
        key,
        type: LoggableType.Raw,
        timestamp: log.getTimestampSources(key, -Infinity, Infinity)?.[index]?.seconds ?? range.timestamps[index],
        value: range.values[index].slice(),
        wpilibType: log.getWpilibType(key),
        metadata: log.getMetadataString(key)
      });
    }
  }

  protected address: string | null = null;
  protected statusCallback: ((status: LiveDataSourceStatus) => void) | null = null;
  protected outputCallback: ((log: Log, timeSupplier: () => number) => void) | null = null;

  private displayKeyToSource: (key: string) => string | null = (key) => key;

  setDisplayKeyResolver(resolver: (key: string) => string | null) {
    this.displayKeyToSource = resolver;
  }

  protected getSourceKeys(keys: string[]): string[] {
    return keys.map(this.displayKeyToSource).filter((key): key is string => key !== null);
  }

  private getDiscardSeconds: () => number = () => -1;

  setDiscardSupplier(supplier: () => number) {
    this.getDiscardSeconds = supplier;
  }

  private clearDataCallback: NodeJS.Timeout | null = null;
  private timeSupplier: (() => number) | null = null;

  /**
   * Generates log data from a live source.
   * @param address The IP address of the source
   * @param statusCallback A callback to be triggered when the status changes
   * @param outputCallback A callback to be triggered whenever new data is available. This function is given a reference to the log object and a supplier function that returns the current server timestamp.
   */
  connect(
    address: string,
    statusCallback: (status: LiveDataSourceStatus) => void,
    outputCallback: (log: Log, timeSupplier: () => number) => void,
    enableClearData = true
  ) {
    this.address = address;
    this.statusCallback = statusCallback;
    this.outputCallback = (log: Log, timeSupplier: () => number) => {
      this.timeSupplier = timeSupplier;
      outputCallback(log, timeSupplier);
    };
    this.setStatus(LiveDataSourceStatus.Connecting);

    // Clear old data
    if (enableClearData) {
      this.clearDataCallback = setInterval(() => {
        if (this.log && this.timeSupplier) {
          let liveDiscardSecs = this.getDiscardSeconds();
          if (liveDiscardSecs !== -1) {
            let minTime = this.timeSupplier() - liveDiscardSecs;
            this.log.clearBeforeTime(Math.max(0, minTime), false);
          }
        }
      }, 1000 / 60);
    }
  }

  getTime(): number | null {
    return this.timeSupplier?.() ?? null;
  }

  /** Cancels the connection. */
  stop() {
    this.setRecordingListener(null);
    this.setStatus(LiveDataSourceStatus.Stopped);
    if (this.clearDataCallback) clearInterval(this.clearDataCallback);
  }

  /** Process new data from the main process, overriden by subclass. */
  handleMainMessage(data: any) {}

  /** Returns an object to be used for sending tuning data, or null if tuning is not supported. */
  getTuner(): LiveDataTuner | null {
    return null;
  }

  /** Updates the current status and triggers the callback if necessary. */
  protected setStatus(status: LiveDataSourceStatus) {
    if (status !== this.status && this.status !== LiveDataSourceStatus.Stopped) {
      this.status = status;
      if (this.statusCallback !== null) this.statusCallback(status);
    }
    if (status !== LiveDataSourceStatus.Active) {
      this.timeSupplier = null;
    }
  }
}

export enum LiveDataSourceStatus {
  Waiting,
  Connecting,
  Active,
  Error,
  Stopped
}
