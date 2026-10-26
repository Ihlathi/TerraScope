// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { Buffer } from "buffer";
import { decode as decodeJPEG } from "jpeg-js";
import { PNG } from "pngjs/browser";
import type { PluginRegistry } from "../plugins/PluginRegistry";
import Log from "./Log";
import LogField from "./LogField";
import { classifyStructuredType } from "./SemanticType";

export type ImagePixels = { width: number; height: number; rgba: Uint8Array };
export type ImageFieldReader = (field: string) => unknown;
export type ImageResult =
  | { status: "empty"; message: string }
  | { status: "error"; message: string }
  | ({ status: "frame"; topic: string; timestamp: number } & ImagePixels);

const MAX_IMAGE_PIXELS = 16_000_000;
const CACHE_SIZE = 3;
const IMAGE_FIELDS = ["", "height", "width", "encoding", "is_bigendian", "step", "format", "data"];

function dimensions(width: unknown, height: unknown): { width: number; height: number } {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new Error("Invalid image dimensions or image exceeds 16 million pixels.");
  return { width, height };
}

function imageBytes(read: ImageFieldReader): Uint8Array {
  const data = read("data");
  if (!(data instanceof Uint8Array)) throw new Error("Image data is missing.");
  return data;
}

export function decodeRawImage(read: ImageFieldReader): ImagePixels {
  const { width, height } = dimensions(read("width"), read("height"));
  const endian = read("is_bigendian") ?? 0;
  if (endian !== 0 && endian !== false) throw new Error("Big-endian images are not supported.");
  const encoding = read("encoding");
  if (encoding !== "rgb8" && encoding !== "bgr8" && encoding !== "mono8") {
    throw new Error(`Unsupported image encoding "${String(encoding)}". Use rgb8, bgr8, or mono8.`);
  }
  const channels = encoding === "mono8" ? 1 : 3;
  const step = read("step");
  const data = imageBytes(read);
  if (
    typeof step !== "number" ||
    !Number.isSafeInteger(step) ||
    step < width * channels ||
    !Number.isSafeInteger(step * height) ||
    data.length < step * height
  ) {
    throw new Error("Image data does not match its dimensions and row stride.");
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const source = row * step + column * channels;
      const target = (row * width + column) * 4;
      rgba[target] = data[source + (encoding === "bgr8" ? 2 : 0)];
      rgba[target + 1] = data[source + (channels === 1 ? 0 : 1)];
      rgba[target + 2] = data[source + (encoding === "rgb8" ? 2 : 0)];
      rgba[target + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export function compressedImageFormat(data: Uint8Array, format: unknown): "jpeg" | "png" {
  const declared = typeof format === "string" ? format.toLowerCase() : "";
  const detected =
    data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      ? "jpeg"
      : data.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => data[index] === value)
      ? "png"
      : null;
  if (detected === null) throw new Error("Unsupported compressed image. Expected JPEG or PNG bytes.");
  if (declared.includes("compresseddepth")) throw new Error("Compressed depth images are not supported.");
  const named = /\bjpe?g\b/.test(declared) ? "jpeg" : /\bpng\b/.test(declared) ? "png" : null;
  if (named !== null && named !== detected) throw new Error("Compressed image format does not match its bytes.");
  if (declared !== "" && named === null) throw new Error(`Unsupported compressed image format "${String(format)}".`);
  return detected;
}

export function decodeCompressedImage(read: ImageFieldReader): ImagePixels {
  const data = imageBytes(read);
  const format = compressedImageFormat(data, read("format"));
  if (format === "jpeg") {
    const decoded = decodeJPEG(data, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: 16,
      maxMemoryUsageInMB: 128
    });
    const size = dimensions(decoded.width, decoded.height);
    return { ...size, rgba: new Uint8Array(decoded.data) };
  }
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  dimensions(header.getUint32(16), header.getUint32(20));
  const decoded = PNG.sync.read(Buffer.from(data));
  return { ...dimensions(decoded.width, decoded.height), rgba: new Uint8Array(decoded.data) };
}

export function readImageFrame(
  log: Log,
  topic: string,
  time: number,
  registry: PluginRegistry,
  uuid?: string
): ImageResult {
  const sample = log.getRange(topic, time, time, uuid);
  if (sample === undefined || sample.values.length === 0 || sample.timestamps[0] > time) {
    return { status: "empty", message: "No image at or before the cursor." };
  }
  const timestamp = sample.timestamps[0];
  const semantic = classifyStructuredType(log.getStructuredType(topic) ?? "");
  const decoder = semantic === null ? undefined : registry.getImageDecoder(semantic);
  if (decoder === undefined) return { status: "error", message: "No image decoder is registered for this topic." };
  const read: ImageFieldReader = (field) => {
    const child = log.getRange(topic + "/" + field, timestamp, timestamp, uuid);
    return child !== undefined && child.values.length > 0 && child.timestamps[0] <= timestamp
      ? child.values[0]
      : undefined;
  };
  try {
    return { status: "frame", topic, timestamp, ...decoder.decode(read) };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Unable to decode image." };
  }
}

export class ImageFrameCache {
  private log: Log | null = null;
  private topic: string | null = null;
  private registry: PluginRegistry | null = null;
  private fields: { field: LogField | null; revision: number }[] = [];
  private frames = new Map<number, ImageResult>();

  clear(): void {
    this.frames.clear();
    this.fields = [];
    this.log = null;
    this.topic = null;
    this.registry = null;
  }

  read(log: Log, topic: string | null, time: number, registry: PluginRegistry, uuid?: string): ImageResult {
    const fields =
      topic === null
        ? []
        : IMAGE_FIELDS.map((suffix) => {
            const field = log.getField(topic + (suffix === "" ? "" : "/" + suffix));
            return { field, revision: field?.getRevision() ?? -1 };
          });
    if (
      this.log !== log ||
      this.topic !== topic ||
      this.registry !== registry ||
      fields.some(
        (entry, index) => entry.field !== this.fields[index]?.field || entry.revision !== this.fields[index]?.revision
      )
    ) {
      this.clear();
      this.log = log;
      this.topic = topic;
      this.registry = registry;
      this.fields = fields;
    }
    if (topic === null)
      return { status: "empty", message: "Drag an Image or CompressedImage topic into the image source list." };
    const sample = log.getRange(topic, time, time, uuid);
    if (sample === undefined || sample.values.length === 0 || sample.timestamps[0] > time) {
      return { status: "empty", message: "No image at or before the cursor." };
    }
    const timestamp = sample.timestamps[0];
    let result = this.frames.get(timestamp);
    if (result === undefined) result = readImageFrame(log, topic, time, registry, uuid);
    this.frames.delete(timestamp);
    this.frames.set(timestamp, result);
    if (this.frames.size > CACHE_SIZE) this.frames.delete(this.frames.keys().next().value!);
    return result;
  }
}
