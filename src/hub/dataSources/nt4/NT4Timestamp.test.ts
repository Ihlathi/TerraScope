// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { test } from "node:test";
import Log from "../../../shared/log/Log";
import { RECEIVE_CLOCK } from "../../../shared/log/LogTimestamp";
import { NT4_SERVER_CLOCK, convertNT4ReceiveTime } from "./NT4Timestamp";

test("NetworkTables explicitly converts receive time to its latency-adjusted server cursor", () => {
  const converted = convertNT4ReceiveTime(1_700_000_000_000_000, -1_699_999_990_000_000, 25_000);
  assert.deepEqual(converted, {
    source: { seconds: 1_700_000_000, domain: RECEIVE_CLOCK },
    display: { seconds: 9.975, domain: NT4_SERVER_CLOCK }
  });
  assert.equal(convertNT4ReceiveTime(1_000_000, 2_000_000, 0).display.seconds, 3);
  assert.equal(convertNT4ReceiveTime(1_000_000, -500_000, 10_000).display.seconds, 0.49);
});

test("NetworkTables server samples retain server time without cursor latency subtraction", () => {
  const log = new Log(true, NT4_SERVER_CLOCK);
  log.putNumber("voltage", { seconds: 10, domain: NT4_SERVER_CLOCK }, 12.4);
  const cursor = convertNT4ReceiveTime(20_000_000, -10_000_000, 25_000);
  assert.equal(cursor.display.seconds, 9.975);
  assert.deepEqual(log.getNumber("voltage", -Infinity, Infinity), { timestamps: [10], values: [12.4] });
  assert.deepEqual(log.getTimestampSources("voltage", -Infinity, Infinity), [
    { seconds: 10, domain: NT4_SERVER_CLOCK }
  ]);
});
