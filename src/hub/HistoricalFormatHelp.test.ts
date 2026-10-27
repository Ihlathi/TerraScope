// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { plugins } from "../shared/plugins/builtins";

async function failedOpen(logPath: string, customError: string | null = null) {
  const messages: { name: string; data: { title: string; content: string } }[] = [];
  const file = "src/hub/hub.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "startHistorical"
  );
  assert(declaration);
  const script = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }
  }).outputText;
  class FailedSource {
    openFile(_log: unknown, _path: string, _prefix: string, status: (value: string) => void) {
      status("Error");
    }
    getCustomError() {
      return customError;
    }
  }
  const start = runInNewContext(script + "\nstartHistorical", {
    plugins,
    recording: { stop: async () => {} },
    historicalSources: [],
    liveSession: { stopAll() {} },
    updateRecording() {},
    setLoading() {},
    setWindowTitle() {},
    Log: class {},
    HistoricalDataSource: FailedSource,
    HistoricalDataSourceStatus: { Error: "Error" },
    window: {
      platform: "linux",
      selection: { getTimelineRange: () => [0, 1], getTimelineIsMaxZoom: () => true },
      sidebar: { refresh() {} },
      tabs: { refresh() {} },
      sendMainMessage: (name: string, data: { title: string; content: string }) => messages.push({ name, data })
    }
  });
  await start(logPath);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].name, "error");
  assert.equal(messages[0].data.title, "Failed to open log");
  return messages[0].data.content;
}

for (const extension of ["csv", "CSV", "tsv", "TsV"]) {
  test(`failed .${extension} open offers CSV decoder format help`, async () => {
    const message = await failedOpen(`match.${extension}`);
    assert.match(message, /required format of CSV files/);
    assert.doesNotMatch(message, /Please try again/);
  });
}

for (const reader of plugins.getReaders().filter((reader) => reader.id !== "csv" && reader.id !== "tsv")) {
  test(`failed ${reader.id} open does not offer CSV decoder format help`, async () => {
    const message = await failedOpen(`match.${reader.extensions[0]}`);
    assert.match(message, /Please try again/);
    assert.doesNotMatch(message, /required format of CSV files/);
  });
}

test("a reader's custom error still replaces format help", async () => {
  assert.equal(await failedOpen("match.CSV", "Decoder diagnostic"), "Decoder diagnostic");
});
