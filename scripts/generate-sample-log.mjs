// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { McapWriter } from "@mcap/core";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// A terrascope-logger output may replace this synthetic sample later.
const output = new URL("../sampleLogs/terrascope-sample.mcap", import.meta.url);
const encoder = new TextEncoder();
const buffers = [];
let position = 0n;
const writer = new McapWriter({
  writable: {
    position: () => position,
    async write(bytes) {
      buffers.push(Buffer.from(bytes));
      position += BigInt(bytes.byteLength);
    }
  },
  chunkSize: 256 * 1024,
  useStatistics: true,
  useMetadataIndex: true
});
await writer.start({ profile: "", library: "TerraScope deterministic sample" });

const number = { type: "number" };
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false
});
const vector = object({ x: number, y: number, z: number });
const schemas = {
  Pose2d: object({ translation: object({ x: number, y: number }), rotation: object({ value: number }) }),
  Pose3d: object({
    translation: vector,
    rotation: object({ q: object({ w: number, x: number, y: number, z: number }) })
  }),
  IMU: object({ yaw: number, pitch: number, roll: number, accel: vector, gyro: vector }),
  Motor: object({ current: number, voltage: number }),
  boolean: { type: "boolean" },
  "number[]": { type: "array", items: number },
  string: { type: "string" }
};
const schemaIds = new Map();
for (const [name, schema] of Object.entries(schemas)) {
  schemaIds.set(
    name,
    await writer.registerSchema({ name, encoding: "jsonschema", data: encoder.encode(JSON.stringify(schema)) })
  );
}
const channelIds = new Map();
const sequences = new Map();
for (const [topic, schema] of [
  ["/Robot/Pose2d", "Pose2d"],
  ["/Robot/Pose3d", "Pose3d"],
  ["/Robot/IMU", "IMU"],
  ...["FrontLeft", "FrontRight", "RearLeft", "RearRight"].map((name) => [`/Robot/Drive/${name}`, "Motor"]),
  ["/Robot/Arm", "Motor"],
  ["/Robot/Enabled", "boolean"],
  ["/Robot/BrakeMode", "boolean"],
  ["/Robot/ArmLimit", "boolean"],
  ["/Robot/NumberArray", "number[]"],
  ["/Robot/Console", "string"]
]) {
  channelIds.set(
    topic,
    await writer.registerChannel({
      topic,
      schemaId: schemaIds.get(schema),
      messageEncoding: "json",
      metadata: new Map()
    })
  );
  sequences.set(topic, 0);
}
await writer.addMetadata({
  name: "TerraScope",
  metadata: new Map([
    ["robot", "TerraScope sample robot"],
    ["wallClockStart", "2026-01-01T12:00:00.000Z"],
    ["description", "Synthetic robot driving a smooth loop and a ramp, with IMU and motor telemetry."],
    ["generatorSeed", "6328"]
  ])
});

let seed = 6328;
function noise() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000 - 0.5;
}
const round = (value) => Math.round(value * 100000) / 100000;
async function message(topic, tick, value) {
  const sequence = sequences.get(topic);
  const nanos = BigInt(tick) * 10000000n;
  await writer.addMessage({
    channelId: channelIds.get(topic),
    sequence,
    logTime: nanos,
    publishTime: nanos,
    data: encoder.encode(JSON.stringify(value))
  });
  sequences.set(topic, sequence + 1);
}
const consoleLines = new Map([
  [0, "[INFO] Sample robot initialized"],
  [217, "[INFO] Robot enabled; beginning loop"],
  [613, "[DEBUG] Drive current tracking nominal"],
  [1079, "[WARN] Ramp crest detected; limiting arm voltage"],
  [1641, "[INFO] Arm limit switch active"],
  [2327, "[DEBUG] IMU calibration stable"],
  [2913, "[WARN] Battery voltage dip under load"],
  [3517, "[INFO] Loop complete; approaching start"],
  [3983, "[INFO] Robot disabled; sample complete"]
]);
for (let tick = 0; tick <= 4000; tick++) {
  const t = tick / 100;
  const theta = (2 * Math.PI * t) / 40;
  const yaw = theta + Math.PI / 2;
  const pitch = 0.2 * Math.sin(2 * theta);
  const roll = 0.025 * Math.sin(3 * theta);
  await message("/Robot/IMU", tick, {
    yaw: round(yaw),
    pitch: round(pitch),
    roll: round(roll),
    accel: {
      x: round(-0.07402 * Math.cos(theta) + noise() * 0.03),
      y: round(-0.07402 * Math.sin(theta) + noise() * 0.03),
      z: round(9.80665 * Math.cos(pitch) + noise() * 0.03)
    },
    gyro: {
      x: round(0.01178 * Math.cos(3 * theta)),
      y: round((Math.PI / 100) * Math.cos(2 * theta)),
      z: round(Math.PI / 20)
    }
  });
  if (tick % 2 === 0) {
    const translation = { x: round(5 + 3 * Math.cos(theta)), y: round(4 + 3 * Math.sin(theta)) };
    await message("/Robot/Pose2d", tick, { translation, rotation: { value: round(yaw) } });
    const cy = Math.cos(yaw / 2),
      sy = Math.sin(yaw / 2),
      cp = Math.cos(pitch / 2),
      sp = Math.sin(pitch / 2);
    await message("/Robot/Pose3d", tick, {
      translation: { ...translation, z: round(0.4 * (1 - Math.cos(2 * theta))) },
      rotation: { q: { w: round(cp * cy), x: round(-sp * sy), y: round(sp * cy), z: round(cp * sy) } }
    });
  }
  if (tick % 4 === 0) {
    const enabled = t >= 2 && t < 38;
    for (const [index, name] of ["FrontLeft", "FrontRight", "RearLeft", "RearRight"].entries()) {
      await message(`/Robot/Drive/${name}`, tick, {
        current: round(enabled ? 14 + 5 * Math.sin(theta * 3 + index * 0.6) + noise() : 0),
        voltage: round(enabled ? 7.5 + 1.5 * Math.sin(theta * 2 + index * 0.2) : 0)
      });
    }
    await message("/Robot/Arm", tick, {
      current: round(enabled ? 5 + 3 * Math.sin(theta * 2) + noise() * 0.5 : 0),
      voltage: round(enabled ? 3 * Math.sin(theta * 2) : 0)
    });
    await message("/Robot/Enabled", tick, enabled);
    await message("/Robot/BrakeMode", tick, t < 2 || t >= 38);
    await message("/Robot/ArmLimit", tick, Math.floor(t / 8) % 2 === 0);
    await message("/Robot/NumberArray", tick, [round(Math.sin(theta)), round(Math.cos(theta)), round(t), round(pitch)]);
  }
  if (consoleLines.has(tick)) await message("/Robot/Console", tick, consoleLines.get(tick));
}
await writer.end();
await mkdir(new URL("../sampleLogs/", import.meta.url), { recursive: true });
const bytes = Buffer.concat(buffers);
if (bytes.length >= 3_000_000) throw new Error(`Sample exceeds 3 MB: ${bytes.length} bytes`);
await writeFile(output, bytes);
console.log(`${fileURLToPath(output)}: ${bytes.length} bytes`);
