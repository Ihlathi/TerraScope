// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { plugins } from "../../shared/plugins/builtins";

const file = "src/main/electron/main.ts";
const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

function loadFunction(name: string, context: Record<string, unknown>) {
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(declaration, `${name} exists in ${file}`);
  const script = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return runInNewContext(script + "\n" + name, context);
}

async function openLog(logPath: string, deleteAfterRead = false): Promise<(Buffer | null)[]> {
  let complete!: (files: (Buffer | null)[]) => void;
  const result = new Promise<(Buffer | null)[]>((resolve) => (complete = resolve));
  const context: Record<string, unknown> = {
    fs,
    path,
    plugins,
    app: { addRecentDocument() {} },
    AKIT_PATH_OUTPUT: path.join(path.dirname(logPath), "recent-path"),
    sendMessage: (_window: unknown, name: string, data: { files: (Buffer | null)[]; error: string | null }) => {
      assert.equal(name, "historical-data");
      assert.equal(data.error, null);
      complete(data.files);
    }
  };
  context.getDSLogPaths = loadFunction("getDSLogPaths", context);
  const handle = loadFunction("handleHubMessage", context);
  await handle(
    { id: 1, isDestroyed: () => false },
    { name: "historical-start", data: { path: logPath, uuid: "reader-test", deleteAfterRead } }
  );
  return result;
}

for (const [logName, eventsName] of [
  ["match.dslog", "match.dsevents"],
  ["match.DSLOG", "match.DSEVENTS"],
  ["match.DsLoG", "match.dSeVeNtS"],
  ["match.practice.1.DsLoG", "match.practice.1.DsEvEnTs"],
  ["match.DSLOG", "match.dsevents"]
]) {
  for (const selected of [logName, eventsName]) {
    test(`opening ${selected} reads its DS log and companion in decoder order`, async (t) => {
      const directory = fs.mkdtempSync(path.join(tmpdir(), "reader-paths-"));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      fs.writeFileSync(path.join(directory, logName), "telemetry");
      fs.writeFileSync(path.join(directory, eventsName), "events");
      const buffers = await openLog(path.join(directory, selected));
      assert.deepEqual(
        Array.from(buffers, (buffer) => buffer?.toString() ?? null),
        ["telemetry", "events"]
      );
    });
  }
}

for (const selected of ["match.DSLOG", "match.DSEVENTS"]) {
  test(`deleteAfterRead removes both DS files when ${selected} is selected`, async (t) => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), "reader-cleanup-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const log = path.join(directory, "match.DSLOG");
    const events = path.join(directory, "match.DSEVENTS");
    fs.writeFileSync(log, "telemetry");
    fs.writeFileSync(events, "events");
    const buffers = await openLog(path.join(directory, selected), true);
    assert.equal(fs.existsSync(log), false);
    assert.equal(fs.existsSync(events), false);
    assert.deepEqual(
      Array.from(buffers, (buffer) => buffer?.toString() ?? null),
      ["telemetry", "events"]
    );
  });
}

for (const selected of ["match.DSLOG", "match.DSEVENTS"]) {
  test(`opening ${selected} tolerates an absent companion`, async (t) => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), "reader-missing-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, selected), "selected");
    const buffers = await openLog(path.join(directory, selected));
    assert.deepEqual(
      Array.from(buffers, (buffer) => buffer?.toString() ?? null),
      selected === "match.DSLOG" ? ["selected", null] : [null, "selected"]
    );
  });
}

test("deleteAfterRead leaves a non-DS reader's neighboring events file alone", async (t) => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), "reader-other-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const csv = path.join(directory, "match.CSV");
  const events = path.join(directory, "match.dsevents");
  fs.writeFileSync(csv, "csv");
  fs.writeFileSync(events, "events");
  const buffers = await openLog(csv, true);
  assert.deepEqual(
    Array.from(buffers, (buffer) => buffer?.toString() ?? null),
    ["csv"]
  );
  assert.equal(fs.existsSync(csv), false);
  assert.equal(fs.existsSync(events), true);
});
