// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";
import { LiveDataSource, LiveDataSourceStatus } from "../LiveDataSource";
import { FOXGLOVE_SUBPROTOCOL, FoxgloveSession, foxgloveWebSocketUrl } from "./FoxgloveSession";

/** Live source for the Foxglove WebSocket protocol. One connection, manual address. */
export default class FoxgloveSource extends LiveDataSource {
  private socket: WebSocket | null = null;
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
    this.socket?.close();
    this.socket = null;
    super.stop();
  }

  private open(address: string, generation: number) {
    if (generation !== this.generation) return;
    let url: string;
    try {
      url = foxgloveWebSocketUrl(address);
    } catch {
      this.setStatus(LiveDataSourceStatus.Error);
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, FOXGLOVE_SUBPROTOCOL);
    } catch (error) {
      console.error(error);
      this.setStatus(LiveDataSourceStatus.Error);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    if (this.log === null) return;
    const session = new FoxgloveSession(
      (text) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
      this.log,
      (timeSupplier) => {
        if (generation !== this.generation || this.log === null || this.outputCallback === null) return;
        this.setStatus(LiveDataSourceStatus.Active);
        this.outputCallback(this.log, timeSupplier);
      },
      () => {
        if (generation !== this.generation) return;
        this.setStatus(LiveDataSourceStatus.Active);
      }
    );
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      try {
        if (typeof event.data === "string") {
          session.handleText(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          session.handleBinary(new Uint8Array(event.data));
        }
      } catch (error) {
        console.error(error);
      }
    };
    socket.onclose = () => {
      if (generation !== this.generation || this.status === LiveDataSourceStatus.Stopped) return;
      this.setStatus(LiveDataSourceStatus.Connecting);
      this.retry = setTimeout(() => this.open(address, generation), 500);
    };
  }
}
