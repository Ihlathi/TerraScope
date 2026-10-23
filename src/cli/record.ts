// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import checkDiskSpace from "check-disk-space";
import path from "node:path";
import { parseArgs } from "node:util";
import { LiveDataSourceStatus } from "../hub/dataSources/LiveDataSource";
import NT4Source, { NT4Mode } from "../hub/dataSources/nt4/NT4Source";
import { RecordingSample, RecordingWriter, recordingSampleSize } from "../shared/recording/RecordingWriter";
import WPILOGRecordingWriter from "../shared/recording/WPILOGRecordingWriter";

interface RecordOptions {
  source: string;
  address: string;
  ports?: number[];
  output: string;
  duration?: number;
  connectTimeout: number;
  minimumFreeBytes?: number;
}

type RecorderPhase = "connecting" | "recording" | "stopping" | "stopped";
type StopReason = { code: 0 | 1; message: string };

const usage = `Record an NT4 source to WPILOG without Electron.

Usage: npm run record -- --source <host[:port]> --output <file.wpilog> [options]

  --source              NT4 address, optionally prefixed with nt4://. Default port 5810.
  --output              Destination file. An existing file is overwritten.
  --duration            Seconds to record after the first connection. Omit to record until Ctrl-C.
  --connect-timeout     Seconds allowed to connect or reconnect. Default 10.
  --minimum-free-bytes  Stop below this free disk threshold. Default 67108864 (64 MiB).
  --help                Show this help.
`;

function positiveSeconds(value: string, option: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number * 1000 > 2_147_483_647) {
    throw new Error(`${option} must be positive and at most 2147483 seconds.`);
  }
  return number;
}

function options(): RecordOptions | null {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      output: { type: "string" },
      duration: { type: "string" },
      "connect-timeout": { type: "string", default: "10" },
      "minimum-free-bytes": { type: "string" },
      help: { type: "boolean" }
    }
  });
  if (values.help) return null;
  if (!values.source?.trim() || !values.output?.trim()) throw new Error("--source and --output are required.");
  const source = values.source;
  let url: URL;
  try {
    url = new URL(source.includes("://") ? source : "nt4://" + source);
  } catch {
    throw new Error("--source must be an NT4 host or host:port.");
  }
  if (
    url.protocol !== "nt4:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash ||
    (url.port !== "" && Number(url.port) === 0)
  )
    throw new Error("--source must be an NT4 host or host:port.");
  const minimumFreeBytes =
    values["minimum-free-bytes"] === undefined ? undefined : Number(values["minimum-free-bytes"]);
  if (minimumFreeBytes !== undefined && (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0)) {
    throw new Error("--minimum-free-bytes must be a nonnegative safe integer.");
  }
  return {
    source,
    address: url.hostname,
    ports: url.port ? [Number(url.port)] : undefined,
    output: path.resolve(values.output),
    duration: values.duration === undefined ? undefined : positiveSeconds(values.duration, "--duration"),
    connectTimeout: positiveSeconds(values["connect-timeout"]!, "--connect-timeout"),
    minimumFreeBytes
  };
}

async function record(options: RecordOptions): Promise<number> {
  let phase: RecorderPhase = "connecting";
  let connected = false;
  let freeBytes = 0;
  let samples = 0;
  const fields = new Set<string>();
  let pending: RecordingSample[] = [];
  let pendingBytes = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let duration: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let finish!: (reason: StopReason) => void;
  const finished = new Promise<StopReason>((resolve) => {
    finish = resolve;
  });
  const isStopping = () => phase === "stopping" || phase === "stopped";
  const requestStop = (reason: StopReason) => {
    if (phase === "stopping" || phase === "stopped") return;
    phase = "stopping";
    finish(reason);
  };
  const writer: RecordingWriter = new WPILOGRecordingWriter(
    options.output,
    (status) => {
      if (status.kind === "error" || (status.kind === "stopped" && status.reason === "low-disk")) {
        requestStop({ code: 1, message: status.message });
      }
    },
    {
      minimumFreeBytes: options.minimumFreeBytes,
      checkFreeSpace: async (directory) => {
        freeBytes = (await checkDiskSpace(directory)).free;
        return freeBytes;
      }
    }
  );
  const status = () => {
    process.stdout.write(
      `connected=${connected ? "yes" : "no"} fields=${fields.size} samples=${samples} bytes=${
        writer.getStatus().bytesWritten
      } free=${freeBytes}\n`
    );
  };
  const source = new NT4Source(NT4Mode.Default, {
    getSubscriptionMode: () => "logging",
    getActiveFields: () => [],
    startPeriodic: (callback) => {
      const interval = setInterval(callback, 20);
      return () => clearInterval(interval);
    },
    onError: (message) => requestStop({ code: 1, message }),
    ports: options.ports
  });
  source.setDiscardSupplier(() => 5);
  const flush = () => {
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    if (batch.length === 0 || writer.getStatus().kind !== "recording") return;
    void writer
      .write(batch)
      .then(() => {
        samples += batch.length;
        batch.forEach((sample) => fields.add(sample.key));
      })
      .catch((error: unknown) =>
        requestStop({ code: 1, message: error instanceof Error ? error.message : String(error) })
      );
  };
  const interrupt = () => requestStop({ code: 0, message: "Recording saved." });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const progress = setInterval(status, 1000);
  const batches = setInterval(flush, 20);
  let result: StopReason;
  try {
    await writer.start();
    if (!isStopping()) {
      source.setRecordingListener((sample) => {
        if (phase === "stopping" || phase === "stopped") return;
        pendingBytes += recordingSampleSize(sample);
        if (pendingBytes > 1024 * 1024) {
          requestStop({ code: 1, message: "Recording stopped because storage could not keep up with incoming data." });
          return;
        }
        pending.push(sample);
      });
      status();
      source.connect(
        options.address,
        (state) => {
          connected = state === LiveDataSourceStatus.Active;
          if (deadline !== undefined) clearTimeout(deadline);
          if (state === LiveDataSourceStatus.Active) {
            phase = "recording";
            if (!started) {
              started = true;
              if (options.duration !== undefined) duration = setTimeout(interrupt, options.duration * 1000);
            }
            status();
          } else if (state === LiveDataSourceStatus.Connecting) {
            phase = "connecting";
            deadline = setTimeout(
              () =>
                requestStop({
                  code: 1,
                  message: `${started ? "Lost connection to" : "Unable to connect to"} NT4 source ${
                    options.source
                  } within ${options.connectTimeout}s.`
                }),
              options.connectTimeout * 1000
            );
          } else if (state === LiveDataSourceStatus.Error) {
            requestStop({ code: 1, message: `Connection to NT4 source ${options.source} failed.` });
          }
        },
        () => {}
      );
    }
    result = await finished;
  } catch (error) {
    result = { code: 1, message: error instanceof Error ? error.message : String(error) };
  } finally {
    phase = "stopping";
    source.stop();
    connected = false;
    clearTimeout(deadline);
    clearTimeout(duration);
    clearInterval(batches);
    clearInterval(progress);
    flush();
    await writer.stop();
    phase = "stopped";
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  const terminal = writer.getStatus();
  if (terminal.kind === "error" || (terminal.kind === "stopped" && terminal.reason === "low-disk")) {
    result = { code: 1, message: terminal.message };
  }
  status();
  (result.code === 0 ? process.stdout : process.stderr).write(result.message + "\n");
  return result.code;
}

async function main() {
  let parsed: RecordOptions | null;
  try {
    parsed = options();
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\nRun with --help for usage.\n");
    process.exitCode = 2;
    return;
  }
  if (parsed === null) process.stdout.write(usage);
  else process.exitCode = await record(parsed);
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
