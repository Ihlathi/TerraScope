// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { ConvertedTimestamp, RECEIVE_CLOCK, TimestampDomain } from "../../../shared/log/LogTimestamp";

export const NT4_SERVER_CLOCK: TimestampDomain = { kind: "clock", id: "nt4-server" };

export function convertNT4ReceiveTime(
  receiveTime_us: number,
  serverOffset_us: number,
  networkLatency_us: number
): ConvertedTimestamp {
  return {
    source: { seconds: receiveTime_us / 1e6, domain: RECEIVE_CLOCK },
    display: { seconds: (receiveTime_us + serverOffset_us - networkLatency_us) / 1e6, domain: NT4_SERVER_CLOCK }
  };
}
