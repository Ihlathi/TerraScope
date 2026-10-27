// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { rolldown } from "rolldown";
import { replacePlugin } from "rolldown/plugins";

for (const [distribution, name] of [
  ["", "FRC6328"],
  ["WPILIB", "WPILib"],
  ["LITE", "Lite"],
  ["LITEDS", "LiteDS"]
]) {
  test(`${name} bundles exactly the workers its registered readers request`, async () => {
    const previous = process.env.ASCOPE_DISTRIBUTION;
    process.env.ASCOPE_DISTRIBUTION = distribution;
    let configs;
    try {
      const config = await import(`../rolldown.config.mjs?distribution=${distribution}`);
      configs = config.default({});
    } finally {
      if (previous === undefined) delete process.env.ASCOPE_DISTRIBUTION;
      else process.env.ASCOPE_DISTRIBUTION = previous;
    }

    const registryBuild = await rolldown({
      input: "src/shared/plugins/builtins.ts",
      plugins: [replacePlugin({ __distribution__: name }, { preventAssignment: true })]
    });
    const registryOutput = await registryBuild.generate({ format: "es" });
    await registryBuild.close();
    const { plugins } = await import(
      `data:text/javascript;base64,${Buffer.from(registryOutput.output[0].code).toString("base64")}`
    );
    const expected = [...new Set(plugins.getReaders().map((reader) => reader.worker))].sort();

    const app = configs.find((config) => config.input.includes("src/hub/hub.ts"));
    const input = app.input.filter(
      (file) => file.endsWith("Worker.ts") && file !== "src/main/lite/xzWorker.ts" && file !== "src/hub/exportWorker.ts"
    );
    assert.deepEqual(input.map((file) => path.basename(file).replace(/\.ts$/, ".js")).sort(), expected);

    const workerBuild = await rolldown({ ...app, input });
    const workerOutput = await workerBuild.generate(app.output);
    await workerBuild.close();
    const emitted = workerOutput.output
      .filter((file) => file.fileName.endsWith("Worker.js"))
      .map((file) => file.fileName)
      .sort();
    assert.deepEqual(emitted, expected);
  });
}
