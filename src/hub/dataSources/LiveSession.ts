// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../shared/log/Log";
import { ClockConversion, RECEIVE_CLOCK } from "../../shared/log/LogTimestamp";
import { sourceClock } from "../../shared/log/ProjectedLogField";
import { LiveDataSource, LiveDataSourceStatus } from "./LiveDataSource";
import LiveDataTuner from "./LiveDataTuner";

interface LiveConnection {
  namespace: string;
  address: string;
  source: LiveDataSource;
  status: LiveDataSourceStatus;
  log: Log | null;
  timeSupplier: (() => number) | null;
  conversion: ClockConversion | null;
  tuner: LiveDataTuner | null;
}

export default class LiveSession implements LiveDataTuner {
  private connections = new Map<string, LiveConnection>();
  private namespaced = false;
  private displayLog = new Log(true, RECEIVE_CLOCK);

  constructor(
    private onChange: () => void,
    private onStatus: (address: string, status: LiveDataSourceStatus) => void,
    private now: () => number = () => Date.now() / 1000
  ) {}

  attach(source: LiveDataSource, address: string, additional = false): string {
    if (this.connections.size >= 2) throw new Error("Only two simultaneous live sources are supported.");
    this.namespaced ||= additional;
    const namespace = this.connections.has("/Live1") ? "/Live2" : "/Live1";
    const entry: LiveConnection = {
      namespace,
      address,
      source,
      status: LiveDataSourceStatus.Waiting,
      log: null,
      timeSupplier: null,
      conversion: null,
      tuner: null
    };
    this.connections.set(namespace, entry);
    source.setDisplayKeyResolver((key) => this.getSourceKey(namespace, key));
    source.connect(
      address,
      (status) => {
        if (this.connections.get(namespace) !== entry) return;
        entry.status = status;
        if (status !== LiveDataSourceStatus.Active) entry.timeSupplier = null;
        this.onStatus(address, status);
        this.onChange();
      },
      (log, timeSupplier) => {
        if (this.connections.get(namespace) !== entry) return;
        if (entry.log !== log || entry.timeSupplier === null) entry.conversion = null;
        entry.log = log;
        entry.timeSupplier = timeSupplier;
        const sourceTime = source.getTime();
        if (entry.conversion === null && sourceTime !== null && Number.isFinite(log.getLastTimestamp())) {
          entry.conversion = {
            from: sourceClock(namespace, log.getDisplayClock()),
            to: RECEIVE_CLOCK,
            offsetSeconds: this.now() - sourceTime
          };
        }
        this.refresh();
      }
    );
    entry.tuner = source.getTuner();
    this.refresh();
    return namespace;
  }

  stop(namespace: string) {
    const entry = this.connections.get(namespace);
    if (entry === undefined) return;
    this.connections.delete(namespace);
    entry.source.stop();
    this.refresh();
  }

  stopAll() {
    const entries = [...this.connections.values()];
    this.connections.clear();
    entries.forEach((entry) => entry.source.stop());
    this.namespaced = false;
    this.displayLog = new Log(true, RECEIVE_CLOCK);
    this.onChange();
  }

  getSources(): LiveDataSource[] {
    return [...this.connections.values()].map((entry) => entry.source);
  }

  getStatus(): LiveDataSourceStatus {
    const statuses = [...this.connections.values()].map((entry) => entry.status);
    if (statuses.includes(LiveDataSourceStatus.Active)) return LiveDataSourceStatus.Active;
    if (statuses.includes(LiveDataSourceStatus.Error)) return LiveDataSourceStatus.Error;
    return LiveDataSourceStatus.Connecting;
  }

  getAddresses(): string[] {
    return [...this.connections.values()].map((entry) => entry.address);
  }

  getSourceKey(namespace: string, key: string): string | null {
    if (!this.connections.has(namespace)) return null;
    if (!this.namespaced) return key;
    const prefix = namespace + "/";
    if (!key.startsWith(prefix)) return null;
    const remainder = key.slice(prefix.length);
    const keys = this.connections.get(namespace)?.log?.getFieldKeys() ?? [];
    return keys.some((field) => field === remainder || field.startsWith(remainder + "/")) ? remainder : "/" + remainder;
  }

  getLog(): Log | null {
    if (this.namespaced) return this.displayLog;
    return [...this.connections.values()][0]?.log ?? null;
  }

  getTimeSupplier(): (() => number) | null {
    const active = [...this.connections.values()].filter(
      (entry) =>
        entry.status === LiveDataSourceStatus.Active &&
        entry.timeSupplier !== null &&
        (!this.namespaced || entry.conversion !== null)
    );
    if (active.length === 0) return null;
    if (!this.namespaced) return active[0].timeSupplier;
    const suppliers = active.map(({ timeSupplier, conversion }) => {
      const offsetSeconds = conversion!.offsetSeconds;
      return () => timeSupplier!() + offsetSeconds;
    });
    return () => Math.max(...suppliers.map((supply) => supply()));
  }

  hasTunableFields(): boolean {
    return [...this.connections.values()].some((entry) => entry.tuner?.hasTunableFields());
  }

  isTunable(key: string): boolean {
    return [...this.connections.values()].some((entry) => {
      const sourceKey = this.getSourceKey(entry.namespace, key);
      return sourceKey !== null && entry.tuner?.isTunable(sourceKey) === true;
    });
  }

  publish(key: string, value: number | boolean) {
    this.forTuner(key, (tuner, sourceKey) => tuner.publish(sourceKey, value));
  }

  unpublish(key: string) {
    this.forTuner(key, (tuner, sourceKey) => tuner.unpublish(sourceKey));
  }

  private forTuner(key: string, action: (tuner: LiveDataTuner, key: string) => void) {
    for (const entry of this.connections.values()) {
      const sourceKey = this.getSourceKey(entry.namespace, key);
      if (sourceKey !== null && entry.tuner !== null) action(entry.tuner, sourceKey);
    }
  }

  private refresh() {
    if (this.namespaced) {
      this.displayLog.setProjectedSources(
        [...this.connections.values()].flatMap((entry) => {
          if (entry.log === null) return [];
          return [
            {
              log: entry.log,
              namespace: entry.namespace,
              conversion: entry.conversion ?? {
                from: sourceClock(entry.namespace, entry.log.getDisplayClock()),
                to: RECEIVE_CLOCK,
                offsetSeconds: this.now() - (entry.log.getLastTimestamp() || this.now())
              }
            }
          ];
        })
      );
    }
    this.onChange();
  }
}
