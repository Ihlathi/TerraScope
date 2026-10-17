// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";
import { LiveDataSource, LiveDataSourceStatus } from "../LiveDataSource";
import { JsonFrameDecoder } from "./JsonFrameDecoder";
import { jsonWebSocketUrl, WebSocketTextTransport } from "./WebSocketTextTransport";

/** Live source for one JSON object per WebSocket text message. Manual address, one connection. */
export default class JsonWebSocketSource extends LiveDataSource {
  private transport: WebSocketTextTransport | null = null;
  private decoder = new JsonFrameDecoder();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  connect(
    address: string,
    statusCallback: (status: LiveDataSourceStatus) => void,
    outputCallback: (log: Log, timeSupplier: () => number) => void
  ) {
    super.connect(address, statusCallback, outputCallback);
    if (window.preferences === null || address.trim().length === 0) {
      this.setStatus(LiveDataSourceStatus.Error);
      return;
    }
    this.log = new Log();
    this.open(address, this.generation);
  }

  stop() {
    this.generation++;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.transport?.stop();
    this.transport = null;
    super.stop();
  }

  private open(address: string, generation: number) {
    if (generation !== this.generation) return;
    let url: string;
    try {
      url = jsonWebSocketUrl(address);
    } catch {
      this.setStatus(LiveDataSourceStatus.Error);
      return;
    }
    let transport: WebSocketTextTransport;
    try {
      transport = new WebSocketTextTransport(url);
    } catch (error) {
      console.error(error);
      this.setStatus(LiveDataSourceStatus.Error);
      return;
    }
    this.transport = transport;
    try {
      transport.start(
        (frame) => {
          if (generation !== this.generation || this.log === null) return false;
          let decoded = false;
          try {
            decoded = this.decoder.decode(this.log, frame);
          } catch (error) {
            console.error(error);
            return true;
          }
          if (decoded && this.outputCallback !== null) {
            this.setStatus(LiveDataSourceStatus.Active);
            this.outputCallback(this.log, () => this.decoder.latestTime);
          }
          return true;
        },
        () => {
          if (generation !== this.generation || this.status === LiveDataSourceStatus.Stopped) return;
          this.setStatus(LiveDataSourceStatus.Connecting);
          this.retry = setTimeout(() => this.open(address, generation), 500);
        }
      );
    } catch (error) {
      console.error(error);
      this.setStatus(LiveDataSourceStatus.Error);
    }
  }
}
