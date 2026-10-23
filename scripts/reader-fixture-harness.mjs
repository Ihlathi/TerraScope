// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { rolldown } from "rolldown";

export const fixturePaths = [
  "src/hub/dataSources/csv/fixtures/sample.tsv",
  "src/hub/dataSources/json/fixtures/sample.json",
  "src/hub/dataSources/json/fixtures/sample.jsonl",
  "src/hub/dataSources/mcap/fixtures/sample.mcap",
  "src/hub/dataSources/ros2/fixtures/sample.db3",
  "src/hub/dataSources/ros2/fixtures/spatial-sensors.db3",
  "src/hub/dataSources/ros2/fixtures/transform-tree.db3",
  "docs/evidence/chunk-11/generic-telemetry.csv",
  "docs/evidence/chunk-16/two-sources.wpilog"
];

async function findWorkers(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await findWorkers(filename)));
    else if (entry.name.endsWith("Worker.ts")) result.push(filename);
  }
  return result;
}

export async function bundleReaders(root, workerNames, output) {
  await mkdir(output, { recursive: true });
  const workers = await findWorkers(path.join(root, "src"));
  for (const workerName of new Set(workerNames)) {
    const sources = workers.filter((filename) => path.basename(filename, ".ts") + ".js" === workerName);
    if (sources.length !== 1)
      throw new Error(`Expected one source for registered worker ${workerName}, found ${sources.length}`);
    const source = sources[0];
    const bundle = await rolldown({ input: source, platform: "node", external: ["sql.js"] });
    await bundle.write({ file: path.join(output, workerName.replace(/\.js$/, ".cjs")), format: "cjs" });
    await bundle.close();
  }
  if (workerNames.includes("wpilogWorker.js")) {
    for (const asset of ["wpilogIndexer.js", "wpilogIndexer.wasm"]) {
      await copyFile(path.join(root, "bundles", asset), path.join(output, asset));
    }
  }
}

export async function decodeFixture(root, fixture, workerName, output) {
  const data = new Uint8Array(await readFile(path.join(root, fixture)));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       globalThis.self = { postMessage: message => parentPort.postMessage(message) };
       require(workerData);
       parentPort.on("message", async data => {
         try { await self.onmessage({ data }); }
         catch (error) { throw error; }
       });`,
      { eval: true, workerData: path.join(output, workerName.replace(/\.js$/, ".cjs")) }
    );
    const timeout = setTimeout(() => finish(new Error(`Timed out opening ${fixture}`)), 30000);
    let fields;
    let log;
    let outstanding = 0;
    function finish(error) {
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(log);
    }
    worker.on("error", finish);
    worker.on("message", (message) => {
      if (message.type === "failed") finish(new Error(`Worker failed to open ${fixture}`));
      else if (message.type === "initial") {
        log = message.log;
        fields = new Set(Object.keys(log.fields));
        if (!message.isPartial || fields.size === 0) finish();
        else {
          outstanding = fields.size;
          for (const key of fields) worker.postMessage({ type: "parseField", key });
        }
      } else if (message.type === "fields") {
        for (const field of message.fields) {
          fields.add(field.key);
          log.fields[field.key] = field.data;
        }
        if (--outstanding === 0) finish();
      }
    });
    worker.postMessage({ type: "start", data: [data] });
  });
}

export async function openFixture(root, fixture, workerName, output) {
  const log = await decodeFixture(root, fixture, workerName, output);
  return Object.keys(log.fields).sort();
}
