// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type URDFSourceKind = "robot" | "packages" | "resources";
type Source = { kind: URDFSourceKind; path: string };
type Request =
  | { action: "pick"; kind: URDFSourceKind }
  | { action: "restore"; kind: URDFSourceKind; reference: unknown };

function readSources(filename: string): Record<string, Source> {
  const empty = () => Object.create(null) as Record<string, Source>;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return empty();
    const sources = empty();
    for (const [id, source] of Object.entries(value)) {
      if (
        source === null ||
        typeof source !== "object" ||
        Array.isArray(source) ||
        !Object.hasOwn(source, "kind") ||
        !Object.hasOwn(source, "path") ||
        !["robot", "packages", "resources"].includes(source.kind) ||
        typeof source.path !== "string" ||
        !path.isAbsolute(source.path)
      )
        continue;
      sources[id] = { kind: source.kind, path: source.path };
    }
    return sources;
  } catch {
    return empty();
  }
}

async function readRobot(filename: string): Promise<string> {
  if (path.extname(filename).toLowerCase() !== ".urdf") throw new Error("Select a .urdf robot file.");
  const file = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    const maxBytes = 10 * 1024 * 1024;
    if (!stats.isFile()) throw new Error("URDF source must be a regular file.");
    if (stats.size > maxBytes) throw new Error("URDF source exceeds the 10 MiB size limit.");
    const buffer = Buffer.alloc(Math.min(stats.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("URDF source exceeds the 10 MiB size limit.");
    if (length > stats.size) throw new Error("URDF source changed while reading. Select it again.");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function loadURDFSource(
  registryPath: string,
  request: Request,
  pick: (kind: URDFSourceKind) => Promise<string | null>
) {
  let selected: string;
  let reference: string;
  if (request.action === "restore") {
    const sources = readSources(registryPath);
    if (
      typeof request.reference !== "string" ||
      !Object.hasOwn(sources, request.reference) ||
      sources[request.reference].kind !== request.kind
    )
      throw new Error("URDF source is unavailable on this computer. Select the local source again.");
    selected = sources[request.reference].path;
    reference = request.reference;
  } else {
    const result = await pick(request.kind);
    if (result === null) return null;
    selected = result;
    reference = "";
  }
  const xml = request.kind === "robot" ? await readRobot(selected) : undefined;
  if (request.kind !== "robot" && !(await fs.promises.stat(selected)).isDirectory())
    throw new Error("URDF resource source must be a directory.");
  if (request.action === "pick") {
    const sources = readSources(registryPath);
    reference =
      Object.keys(sources).find((key) => sources[key].kind === request.kind && sources[key].path === selected) ??
      randomUUID();
    sources[reference] = { kind: request.kind, path: selected };
    fs.writeFileSync(registryPath, JSON.stringify(sources));
  }
  return {
    kind: request.kind,
    reference,
    restoring: request.action === "restore",
    url: pathToFileURL(selected + (request.kind !== "robot" ? path.sep : "")).href,
    name: path.basename(selected),
    ...(xml === undefined ? {} : { xml })
  };
}
