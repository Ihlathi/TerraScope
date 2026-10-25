// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WPILOGDecoder, WPILOGDecoderRecord } from "../hub/dataSources/wpilog/WPILOGDecoder";
import { createNT4Fixture } from "./recordFixture";

async function destination(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "terrascope-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "record.wpilog");
}

function cli(t: TestContext, args: string[]) {
  const child = spawn(process.execPath, [path.join(__dirname, "record.js"), ...args], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  t.after(async () => {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async done() {
      const result = await exited;
      clearTimeout(timer);
      assert.equal(result.signal, null, `CLI did not exit cleanly. ${stdout}\n${stderr}`);
      return result.code;
    },
    async waitFor(pattern: RegExp) {
      const end = Date.now() + 5000;
      while (!pattern.test(stdout) && Date.now() < end && child.exitCode === null) await delay(10);
      assert.match(stdout, pattern, stderr);
    }
  };
}

async function readRecording(file: string) {
  const decoder = new WPILOGDecoder(await readFile(file));
  assert(decoder.isValid(), "CLI output must be a valid WPILOG");
  const records: WPILOGDecoderRecord[] = [];
  decoder.forEach((record) => records.push(record));
  const definitions = new Map(
    records
      .filter((record) => record.isStart())
      .map((record) => {
        const data = record.getStartData();
        return [data.entry, data];
      })
  );
  const samples = records
    .filter((record) => !record.isControl())
    .map((record) => {
      const field = definitions.get(record.getEntry())!;
      const readers: Record<string, () => unknown> = {
        double: () => record.getDouble(),
        boolean: () => record.getBoolean(),
        string: () => record.getString(),
        "double[]": () => record.getDoubleArray()
      };
      return {
        key: field.name,
        timestamp: record.getTimestamp(),
        value: (readers[field.type] ?? (() => record.getRaw()))(),
        metadata: field.metadata,
        type: field.type
      };
    });
  return { records, samples };
}

async function assertFixture(file: string) {
  const { samples } = await readRecording(file);
  const values = (key: string) =>
    samples.filter((sample) => sample.key === key).map(({ timestamp, value }) => [timestamp, value]);
  assert.deepEqual(values("NT:/voltage"), [
    [12_345_678, 12.5],
    [12_345_678, 12.5]
  ]);
  assert.equal(samples.find((sample) => sample.key === "NT:/voltage")!.metadata, '{"unit":"V"}');
  assert.deepEqual(values("NT:/enabled"), [[12_345_679, true]]);
  assert.deepEqual(values("NT:/label"), [[12_345_680, "ready λ"]]);
  assert.deepEqual(values("NT:/values"), [[12_345_681, [1.5, -2]]]);
  assert.deepEqual(values("NT:/.schema/struct:Position"), [[12_345_682, new TextEncoder().encode("double x;")]]);
  assert.deepEqual(values("NT:/position/x"), [[12_345_683, 3.25]]);
  assert.deepEqual(values("NT:/raw"), [[12_345_684, new Uint8Array([0, 255, 4])]]);
}

test(
  "CLI duration records actual NT4 values, metadata, schemas and repeated samples through the existing reader",
  { timeout: 10000 },
  async (t) => {
    const server = await createNT4Fixture();
    t.after(() => server.close());
    const output = await destination(t);
    const run = cli(t, ["--source", server.address, "--output", output, "--duration", "0.5"]);
    assert.equal(await run.done(), 0, run.stderr);
    assert.match(run.stdout, /connected=yes/);
    assert.match(run.stdout, /fields=\d+ samples=\d+ bytes=\d+ free=\d+/);
    assert.match(run.stdout, /Recording saved/);
    await assertFixture(output);
  }
);

test("CLI SIGINT drains accepted samples and closes a readable recording", { timeout: 10000 }, async (t) => {
  const server = await createNT4Fixture();
  t.after(() => server.close());
  const output = await destination(t);
  const run = cli(t, ["--source", `nt4://${server.address}`, "--output", output]);
  await run.waitFor(/samples=[1-9]\d*/);
  run.child.kill("SIGINT");
  assert.equal(await run.done(), 0, run.stderr);
  await assertFixture(output);
});

test("CLI connection failure exits nonzero with the address and a clear message", { timeout: 10000 }, async (t) => {
  const server = await createNT4Fixture();
  const address = server.address;
  await server.close();
  const output = await destination(t);
  const run = cli(t, ["--source", address, "--output", output, "--connect-timeout", "0.15"]);
  assert.equal(await run.done(), 1);
  assert.match(run.stderr, /Unable to connect to NT4 source 127\.0\.0\.1:\d+/);
  assert.deepEqual((await readRecording(output)).samples, []);
});

test("CLI connection timeout closes an unfinished WebSocket handshake", { timeout: 10000 }, async (t) => {
  const server = await createNT4Fixture({ upgrade: false });
  t.after(() => server.close());
  const output = await destination(t);
  const run = cli(t, ["--source", server.address, "--output", output, "--connect-timeout", "0.15"]);
  assert.equal(await run.done(), 1);
  assert.match(run.stderr, /Unable to connect/);
  assert.doesNotMatch(run.stderr, /RangeError|Maximum call stack size exceeded/);
  assert.deepEqual((await readRecording(output)).samples, []);
});

test("CLI reconnect timeout reports a lost connection and retains recorded data", { timeout: 10000 }, async (t) => {
  const server = await createNT4Fixture();
  t.after(() => server.close());
  const output = await destination(t);
  const run = cli(t, ["--source", server.address, "--output", output, "--connect-timeout", "0.3"]);
  await run.waitFor(/samples=[1-9]\d*/);
  server.disconnect();
  assert.equal(await run.done(), 1);
  assert.match(run.stderr, /Lost connection to NT4 source/);
  assert.doesNotMatch(run.stderr, /RangeError|Maximum call stack size exceeded/);
  await assertFixture(output);
});

test("CLI SIGINT during a delayed HTTP probe never starts a late WebSocket", { timeout: 10000 }, async (t) => {
  const server = await createNT4Fixture({ holdProbe: true });
  t.after(() => server.close());
  const output = await destination(t);
  const run = cli(t, ["--source", server.address, "--output", output]);
  await server.probeStarted;
  run.child.kill("SIGINT");
  await run.waitFor(/Recording saved/);
  server.releaseProbe();
  assert.equal(await run.done(), 0, run.stderr);
  assert.equal(server.upgrades, 0);
  assert.deepEqual((await readRecording(output)).samples, []);
});

test(
  "CLI low disk failure reports nonzero and leaves an existing destination intact",
  { timeout: 10000 },
  async (t) => {
    const output = await destination(t);
    await writeFile(output, "keep this file");
    const run = cli(t, [
      "--source",
      "127.0.0.1",
      "--output",
      output,
      "--minimum-free-bytes",
      String(Number.MAX_SAFE_INTEGER)
    ]);
    assert.equal(await run.done(), 1);
    assert.match(run.stderr, /disk space is low/);
    assert.equal(await readFile(output, "utf8"), "keep this file");
  }
);

test("CLI rejects invalid duration before touching the output", { timeout: 10000 }, async (t) => {
  const output = await destination(t);
  const run = cli(t, ["--source", "127.0.0.1", "--output", output, "--duration", "NaN"]);
  assert.equal(await run.done(), 2);
  assert.match(run.stderr, /--duration must be positive/);
  await assert.rejects(readFile(output));
});
