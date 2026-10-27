// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const repo = path.resolve(__dirname, "../../..");
const output = process.env.SCENE_OUTPUT || __dirname;
const mode = process.argv[2] || "urdf";
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  let page;
  for (let i = 0; i < 120; i++) {
    try {
      page = (
        await (
          await fetch(`http://127.0.0.1:${process.env.SCENE_PORT || 9222}/json/list`, {
            signal: AbortSignal.timeout(1000)
          })
        ).json()
      ).find((p) => p.url.endsWith("/hub.html"));
    } catch {}
    if (page) break;
    await wait(250);
  }
  assert(page, "Electron hub available");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const seq = ++id;
      const timeout = setTimeout(() => {
        pending.delete(seq);
        reject(new Error(`CDP timeout for ${method}`));
      }, 20000);
      pending.set(seq, (message) => {
        clearTimeout(timeout);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      });
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (await evaluate("!!window.preferences && !!window.tabs && !!window.assets")) break;
      await wait(100);
    }
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    await evaluate(
      "window.preferences={...window.preferences,theme:'light',field3dModeAc:'standard',field3dAntialiasing:false,timestamps:'original',hasScrolledTimeline:true}"
    );
    const save = async (name) => {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(shot.data, "base64"));
    };
    const open = async (file, ready) => {
      await evaluate(
        `window.messagePort.onmessage({data:{name:'open-files',data:{files:[${JSON.stringify(file)}],merge:false}}})`
      );
      for (let i = 0; i < 200; i++) {
        if (await evaluate(ready)) return;
        await wait(100);
      }
      assert.fail("Log fixture opened: " + file + "\n" + (await evaluate("document.body.innerText")));
    };
    const layout = (title, fixedFrame = "map") => ({
      selected: 0,
      tabs: [
        {
          type: 3,
          controllerUUID: "61db089b-ccef-4f20-9692-4a10cda00015",
          title,
          controller: {
            game: "custom",
            fixedFrame,
            sources: [],
            customEnvironment: { lengthMeters: 7, widthMeters: 5, originXMeters: -2, originYMeters: -2.5 }
          },
          renderer: { cameraIndex: -1, orbitFov: 45, cameraPosition: [5, 4, 6], cameraTarget: [0.8, 0.5, 0.4] },
          controlsHeight: 300
        }
      ]
    });
    const scene = async () =>
      evaluate(
        `(()=>{const tab=window.tabs.tabList[0];const entries=tab.renderer.implementation.objectManagers;return {time:window.selection.getRenderTime(),command:tab.controller.getCommand(),managers:entries.map(e=>({type:e.type,diagnostics:e.manager.getDiagnostics?.(),normals:e.type==='urdf'?(()=>{const n=[];e.manager.group.traverse(x=>{if(x.isMesh)n.push(!!x.geometry.getAttribute('normal'))});return n})():undefined,links:e.manager.links?Array.from(e.manager.links).map(([name,link])=>({name,visible:link.visible,position:link.position.toArray(),quaternion:link.quaternion.toArray(),children:link.children.map(c=>({children:c.children.map(x=>({type:x.type,quaternion:x.quaternion.toArray(),children:x.children.map(y=>({type:y.type,quaternion:y.quaternion.toArray()}))}))}))})):undefined,meshCounts:e.manager.meshes?.map(x=>({count:x.count,meshes:x.meshes?.map(m=>m?{count:m.count,vertices:m.geometry.getAttribute('position')?.count}:null)}))})),alert:document.querySelector('.field-3d-frame-alert')?.textContent}})()`
      );
    const observations = [];
    if (mode === "urdf") {
      const directory = path.join(repo, "src/hub/dataSources/ros2/fixtures/urdf");
      await open(path.join(directory, "robot.db3"), "window.log.getFieldKeys().includes('/robot_description')");
      const state = layout("URDF articulated robot replay");
      state.tabs[0].controller.urdf = { description: "/robot_description", joints: "/joint_states" };
      await evaluate(
        `window.tabs.restoreState(${JSON.stringify(
          state
        )});window.selection.setTimelineRange([1,3],false);window.selection.setSelectedTime(1.5);window.tabs.tabList[0].controller.meshBaseUrl=${JSON.stringify(
          pathToFileURL(directory + "/").href
        )};window.tabs.tabList[0].controller.packageRootUrl=${JSON.stringify(
          pathToFileURL(path.join(directory, "packages") + "/").href
        )}`
      );
      await wait(2200);
      for (const time of [1.5, 2.5, 1.5]) {
        await evaluate(`window.selection.setSelectedTime(${time})`);
        await wait(500);
        const state = await scene();
        assert.equal(state.time, time);
        const command = state.command.objects.find((o) => o.type === "urdf");
        assert(command, "URDF command rendered");
        assert.equal(Object.hasOwn(command, "robot"), false, "Robot model excluded from frame command");
        assert.equal(typeof command.modelId, "string");
        assert.equal(command.links.length, 4);
        assert.equal(state.command.frameDiagnostics?.length ?? 0, 0);
        const rendered = state.managers.find((o) => o.type === "urdf");
        assert(rendered, "URDF renderer manager exists");
        assert.deepEqual(rendered.diagnostics, []);
        assert(rendered.links.every((link) => link.visible));
        const shoulder = command.links.find((link) => link.name === "arm_link").pose;
        const expected = time === 1.5 ? [1, 0, 0, 0] : [Math.cos(0.5), 0, 0, Math.sin(0.5)];
        shoulder.rotation.forEach((value, i) => assert(Math.abs(value - expected[i]) < 1e-9));
        observations.push(state);
        if (observations.length <= 2) await save(`urdf-${time}`);
      }
      assert.deepEqual(
        observations[0].command.objects.find((o) => o.type === "urdf").links,
        observations[2].command.objects.find((o) => o.type === "urdf").links
      );
      assert.notDeepEqual(
        observations[0].command.objects.find((o) => o.type === "urdf").links,
        observations[1].command.objects.find((o) => o.type === "urdf").links
      );
      const scratch = path.join(repo, "build/urdf-visual-verification");
      fs.mkdirSync(scratch, { recursive: true });
      let dae = fs.readFileSync(path.join(directory, "packages/demo/meshes/tool.dae"), "utf8");
      dae = dae
        .replace("Z_UP", "Y_UP")
        .replace(
          'count="12">0 0 0 1 0 0 0 1 0 0 0 1',
          'count="24">-0.2 0 -0.2 0.2 0 -0.2 0.2 1.8 -0.2 -0.2 1.8 -0.2 -0.2 0 0.2 0.2 0 0.2 0.2 1.8 0.2 -0.2 1.8 0.2'
        )
        .replace('count="4" stride="3"', 'count="8" stride="3"')
        .replace('<triangles count="4">', '<triangles count="12">')
        .replace("0 2 1 0 1 3 0 3 2 1 2 3", "0 2 1 0 3 2 4 5 6 4 6 7 0 1 5 0 5 4 1 2 6 1 6 5 2 3 7 2 7 6 3 0 4 3 4 7");
      fs.writeFileSync(path.join(scratch, "upright-y.dae"), dae);
      const xml =
        '<robot name="Y_UP upright"><link name="base_link"><visual><origin xyz="0 0 .1"/><geometry><box size="1 1 .2"/></geometry><material><color rgba=".1 .35 .85 1"/></material></visual><visual><origin xyz="0 0 .2"/><geometry><mesh filename="upright-y.dae"/></geometry><material><color rgba=".95 .4 .05 1"/></material></visual></link></robot>';
      const upright = layout("Y_UP COLLADA model upright");
      upright.tabs[0].renderer.cameraTarget = [0, 0, 0.9];
      upright.tabs[0].renderer.cameraPosition = [4, 3, 4];
      fs.writeFileSync(path.join(scratch, "upright.urdf"), xml);
      const picked = {
        kind: "robot",
        xml,
        url: pathToFileURL(path.join(scratch, "upright.urdf")).href,
        name: "Y_UP upright",
        reference: "verification-y-up"
      };
      await evaluate(
        `window.tabs.restoreState(${JSON.stringify(
          upright
        )});window.messagePort.onmessage({data:{name:'urdf-picked',data:{...${JSON.stringify(
          picked
        )},uuid:window.tabs.tabList[0].controller.UUID}}});window.selection.setSelectedTime(1.5)`
      );
      await wait(1800);
      const uprightState = await scene();
      const manager = uprightState.managers.find((e) => e.type === "urdf");
      assert(manager);
      assert.deepEqual(manager.diagnostics, []);
      assert(manager.normals.every(Boolean), "DAE mesh has normals for visible lighting");
      const colladaQuaternion = manager.links[0].children[1].children[0].children[0].quaternion;
      assert(Math.abs(colladaQuaternion[0] - Math.SQRT1_2) < 1e-9, "Y_UP mesh rotated +90 degrees around X");
      await save("dae-y-up-upright");
      fs.writeFileSync(
        path.join(output, "urdf-observations.json"),
        JSON.stringify({ observations, upright: uprightState }, null, 2) + "\n"
      );
      console.log(
        "PASS: URDF bag renders at 1.5 and 2.5, rewind restores links, Y_UP DAE is upright with +90 degree X rotation."
      );
    } else {
      assert(["wpilib", "wpilib-main"].includes(mode));
      const scratch = path.join(repo, "build/urdf-visual-verification");
      fs.mkdirSync(scratch, { recursive: true });
      const bundledEncoder = path.join(scratch, "WPILOGEncoder.cjs");
      execFileSync(
        path.join(repo, "node_modules/.bin/rolldown"),
        [
          path.join(repo, "src/hub/dataSources/wpilog/WPILOGEncoder.ts"),
          "--platform",
          "node",
          "--format",
          "cjs",
          "-o",
          bundledEncoder
        ],
        { stdio: "pipe" }
      );
      const { WPILOGEncoder, WPILOGEncoderRecord: Record } = require(bundledEncoder);
      const encoder = new WPILOGEncoder("TerraScope WPILib robot visual regression fixture");
      let entry = 0;
      const start = (name, type) => {
        entry++;
        encoder.add(Record.makeControlStart(0, { entry, name, type, metadata: "" }));
        return entry;
      };
      for (const [name, schema] of [
        ["Translation3d", "double x;double y;double z;"],
        ["Quaternion", "double w;double x;double y;double z;"],
        ["Rotation3d", "Quaternion q;"],
        ["Pose3d", "Translation3d translation;Rotation3d rotation;"]
      ]) {
        const id = start("/.schema/struct:" + name, "structschema");
        encoder.add(Record.makeRaw(id, 0, Buffer.from(schema)));
      }
      const poseEntry = start("/Robot/Pose", "struct:Pose3d");
      const bytes = Buffer.alloc(56);
      [0.8, 0.5, 0, 1, 0, 0, 0].forEach((v, i) => bytes.writeDoubleLE(v, i * 8));
      encoder.add(Record.makeRaw(poseEntry, 1000000, bytes));
      encoder.add(Record.makeRaw(poseEntry, 3000000, bytes));
      const file = path.join(scratch, "wpilib-robot.wpilog");
      fs.writeFileSync(file, encoder.getEncoded());
      await open(file, "window.log.getFieldKeys().includes('/Robot/Pose')");
      const state = layout("WPILib log with existing KitBot model", "");
      state.tabs[0].renderer.cameraPosition = [4, 3, 4];
      await evaluate(
        `window.tabs.restoreState(${JSON.stringify(
          state
        )});window.selection.setTimelineRange([1,3],false);window.selection.setSelectedTime(1.5);window.tabs.tabList[0].controller.sourceList.setState([{logKey:'/Robot/Pose',logType:'Pose3d',type:'robot',visible:true,options:{model:'KitBot'}}])`
      );
      await wait(2800);
      const result = await scene();
      const robot = result.command.objects.find((o) => o.type === "robot");
      assert(robot, "WPILib robot command exists");
      assert.equal(robot.poses.length, 1);
      assert.deepEqual(robot.poses[0].pose.translation, [0.8, 0.5, 0]);
      assert(!result.command.objects.some((o) => o.type === "urdf"), "URDF None preserves existing robot path");
      assert(
        result.managers.some(
          (e) => e.type === "robot" && e.meshCounts?.some((m) => m.meshes?.some((x) => x?.vertices > 0))
        ),
        "Existing robot meshes loaded"
      );
      await save(mode === "wpilib" ? "wpilib-robot" : "wpilib-robot-main");
      const rect = await evaluate(
        `(()=>{const r=document.querySelector('.field-3d-canvas').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`
      );
      const canvas = await call("Page.captureScreenshot", { format: "png", clip: rect });
      fs.writeFileSync(path.join(output, mode + "-canvas.png"), Buffer.from(canvas.data, "base64"));
      fs.writeFileSync(path.join(output, mode + "-observations.json"), JSON.stringify(result, null, 2) + "\n");
      if (mode === "wpilib") {
        const { PNG } = require("pngjs");
        const baseline = PNG.sync.read(fs.readFileSync(path.join(output, "wpilib-main-canvas.png")));
        const actual = PNG.sync.read(fs.readFileSync(path.join(output, "wpilib-canvas.png")));
        assert.equal(actual.width, baseline.width);
        assert.equal(actual.height, baseline.height);
        assert(actual.data.equals(baseline.data), "Existing WPILib robot canvas is unchanged");
        fs.writeFileSync(
          path.join(output, "wpilib-second-fixup-comparison.json"),
          JSON.stringify(
            {
              changedPixels: 0,
              width: actual.width,
              height: actual.height,
              baseline: "committed main canvas snapshot"
            },
            null,
            2
          ) + "\n"
        );
        console.log("PASS: existing WPILib robot canvas is unchanged, with zero changed pixels.");
      }
      if (mode === "wpilib-main") {
        const current = JSON.parse(fs.readFileSync(path.join(output, "wpilib-observations.json")));
        assert.deepEqual(result.command, current.command, "WPILib render commands match main exactly");
        const { PNG } = require("pngjs");
        const a = PNG.sync.read(fs.readFileSync(path.join(output, "wpilib-canvas.png")));
        const b = PNG.sync.read(fs.readFileSync(path.join(output, "wpilib-main-canvas.png")));
        assert.equal(a.width, b.width);
        assert.equal(a.height, b.height);
        let changedPixels = 0;
        for (let i = 0; i < a.data.length; i += 4)
          if (!a.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4))) changedPixels++;
        assert.equal(changedPixels, 0, "WPILib robot pixels match main");
        fs.writeFileSync(
          path.join(output, "wpilib-compatibility.json"),
          JSON.stringify({ commandEqual: true, changedPixels, width: a.width, height: a.height }, null, 2) + "\n"
        );
      }
      console.log(
        "PASS: actual WPILOG reader renders existing KitBot; URDF is None. " +
          (mode === "wpilib-main" ? "Main render command and canvas pixels match exactly." : "")
      );
    }
  } finally {
    socket.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
