// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "../../../shared/log/Log";

export const FOXGLOVE_SUBPROTOCOL = "foxglove.websocket.v1";
export const FOXGLOVE_DEFAULT_PORT = 8765;
const MESSAGE_DATA_OPCODE = 1;

export interface FoxgloveChannel {
  id: number;
  topic: string;
  encoding: string;
  schemaName: string;
}

/** Builds a Foxglove WebSocket URL from a typed address. Schemes are kept; a bare host uses port 8765. */
export function foxgloveWebSocketUrl(address: string, defaultPort = FOXGLOVE_DEFAULT_PORT): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    const host = trimmed.slice(0, colon);
    const hostIsIpv6 = host.includes(":");
    const hostIsBracketed = host.startsWith("[") && host.endsWith("]");
    if (!hostIsIpv6 || hostIsBracketed) {
      return "ws://" + trimmed;
    }
  }
  return "ws://" + trimmed + ":" + defaultPort.toString();
}

/** Encodes a ws-protocol message-data frame (opcode 1). */
export function encodeMessageData(subscriptionId: number, timestampNs: bigint, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(13 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, MESSAGE_DATA_OPCODE);
  view.setUint32(1, subscriptionId, true);
  view.setBigUint64(5, timestampNs, true);
  frame.set(payload, 13);
  return frame;
}

/**
 * Foxglove ws-protocol client session. Handles serverInfo, channel advertise, subscribe, and message data.
 * JSON payloads become log fields. Other encodings are stored as raw bytes with the schema name.
 */
export class FoxgloveSession {
  private channels = new Map<number, FoxgloveChannel>();
  private subscribedChannelIds = new Set<number>();
  private subscriptionToChannel = new Map<number, number>();
  private nextSubscriptionId = 1;
  private sawServerInfo = false;
  private pending: FoxgloveChannel[] = [];
  private latestTime = 0;

  constructor(
    private sendText: (text: string) => void,
    private log: Log,
    private onUpdate: (timeSupplier: () => number) => void,
    private onServerInfo?: () => void
  ) {}

  handleText(text: string) {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message === null || typeof message.op !== "string") return;
    if (message.op === "serverInfo") {
      this.sawServerInfo = true;
      const queued = this.pending;
      this.pending = [];
      this.subscribeChannels(queued);
      if (this.onServerInfo) this.onServerInfo();
      return;
    }
    if (message.op === "advertise" && Array.isArray(message.channels)) {
      const fresh: FoxgloveChannel[] = [];
      for (const channel of message.channels) {
        if (typeof channel?.id !== "number") continue;
        const info: FoxgloveChannel = {
          id: channel.id,
          topic: typeof channel.topic === "string" ? channel.topic : "",
          encoding: typeof channel.encoding === "string" ? channel.encoding : "",
          schemaName: typeof channel.schemaName === "string" ? channel.schemaName : ""
        };
        this.channels.set(info.id, info);
        if (!this.subscribedChannelIds.has(info.id)) fresh.push(info);
      }
      if (this.sawServerInfo) this.subscribeChannels(fresh);
      else this.pending.push(...fresh);
    }
  }

  handleBinary(data: Uint8Array) {
    if (data.byteLength < 13 || data[0] !== MESSAGE_DATA_OPCODE) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const subscriptionId = view.getUint32(1, true);
    const timestampNs = view.getBigUint64(5, true);
    const channelId = this.subscriptionToChannel.get(subscriptionId);
    if (channelId === undefined) return;
    const channel = this.channels.get(channelId);
    if (channel === undefined) return;
    const seconds = Number(timestampNs) / 1e9;
    this.latestTime = seconds;
    this.writeSample(channel, seconds, data.subarray(13));
    this.onUpdate(() => this.latestTime);
  }

  private subscribeChannels(channels: FoxgloveChannel[]) {
    const subscriptions: { id: number; channelId: number }[] = [];
    for (const channel of channels) {
      if (this.subscribedChannelIds.has(channel.id)) continue;
      const id = this.nextSubscriptionId++;
      this.subscribedChannelIds.add(channel.id);
      this.subscriptionToChannel.set(id, channel.id);
      subscriptions.push({ id, channelId: channel.id });
    }
    if (subscriptions.length === 0) return;
    this.sendText(JSON.stringify({ op: "subscribe", subscriptions }));
  }

  private writeSample(channel: FoxgloveChannel, timestamp: number, payload: Uint8Array) {
    const key = channel.topic.length > 0 ? channel.topic : "channel/" + channel.id.toString();
    if (channel.encoding.toLowerCase() === "json") {
      this.writeJson(key, timestamp, payload);
      return;
    }
    this.log.putRaw(key, timestamp, payload);
    if (channel.schemaName.length > 0) {
      this.log.setStructuredType(key, channel.schemaName);
    }
  }

  private writeJson(key: string, timestamp: number, payload: Uint8Array) {
    let text: string;
    try {
      text = new TextDecoder().decode(payload);
    } catch {
      this.log.putRaw(key, timestamp, payload);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.log.putString(key, timestamp, text);
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      this.log.putNumber(key, timestamp, value);
    } else if (typeof value === "boolean") {
      this.log.putBoolean(key, timestamp, value);
    } else if (typeof value === "string") {
      this.log.putString(key, timestamp, value);
    } else if (value !== null && typeof value === "object") {
      this.log.putJSON(key, timestamp, text);
    }
  }
}
