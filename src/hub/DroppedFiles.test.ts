// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import test from "node:test";
import { PluginRegistry } from "../shared/plugins/PluginRegistry";
import { classifyDroppedFiles } from "./DroppedFiles";

const readers = new PluginRegistry();
readers.registerReader({
  id: "test-logs",
  displayName: "Test logs",
  extensions: ["wpilog", "dslog", "dsevents", "csv"],
  worker: "testWorker.js"
});

test("supported drops open every file in order without an error", () => {
  const paths = ["/logs/first.wpilog", "/logs/second.csv", "/logs/third.dslog"];
  assert.deepEqual(classifyDroppedFiles(paths, readers), { files: paths });
});

test("unsupported drops open nothing and report every rejected file name", () => {
  assert.deepEqual(classifyDroppedFiles(["/logs/notes.unknown", "C:\\logs\\report.pdf", "/logs/README"], readers), {
    files: [],
    error: {
      title: "Failed to open log",
      content:
        "The following files could not be opened because their file type is unsupported:\n\n" +
        "notes.unknown\nreport.pdf\nREADME"
    }
  });
});

test("mixed drops open supported files and report every unsupported file", () => {
  assert.deepEqual(
    classifyDroppedFiles(
      ["/logs/notes.unknown", "/logs/first.wpilog", "/logs/report.pdf", "/logs/second.csv"],
      readers
    ),
    {
      files: ["/logs/first.wpilog", "/logs/second.csv"],
      error: {
        title: "Failed to open log",
        content:
          "The following files could not be opened because their file type is unsupported:\n\n" +
          "notes.unknown\nreport.pdf"
      }
    }
  );
});

test("drop extension matching preserves the existing open path rules", () => {
  const paths = [
    "/logs/robot.match.WPILOG",
    "C:\\logs\\robot.match.DSLOG",
    "/logs/robot.match.DSEVENTS",
    "/logs/.wpilog",
    "/logs/.dslog",
    "/logs/.dsevents",
    "/logs/robot.WpIlOg",
    "/logs/robot.DsLoG",
    "/logs/robot.DsEvEnTs"
  ];
  assert.deepEqual(classifyDroppedFiles(paths, readers), { files: paths });
  assert.deepEqual(classifyDroppedFiles(["/logs/robot.wpilog.backup"], readers), {
    files: [],
    error: {
      title: "Failed to open log",
      content: "The following files could not be opened because their file type is unsupported:\n\nrobot.wpilog.backup"
    }
  });
});

test("an empty drop opens nothing and reports nothing", () => {
  assert.deepEqual(classifyDroppedFiles([], readers), { files: [] });
});
