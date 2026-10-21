// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const repoRoot = path.resolve(__dirname, "../../..");
const WebSocket = require(path.join(repoRoot, "node_modules/ws"));
const mode = process.argv[2];
const output = process.env.SCENE_OUTPUT || path.join(repoRoot, "build/spatial-scene");
fs.mkdirSync(output, { recursive: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  if (mode === "compare") {
    const { PNG } = require(path.join(repoRoot, "node_modules/pngjs"));
    const before = JSON.parse(fs.readFileSync(path.join(output, "baseline-state.json")));
    const after = JSON.parse(fs.readFileSync(path.join(output, "updated-state.json")));
    assert.equal(before.command.objects.find((o) => o.type === "trajectory").poses.length, 3);
    assert.deepEqual(before.command.objects.find((o) => o.type === "axes").poses[0].pose.rotation, [1, 0, 0, 0]);
    assert.deepEqual(after.command, before.command);
    const a = PNG.sync.read(fs.readFileSync(path.join(output, "baseline-canvas.png")));
    const b = PNG.sync.read(fs.readFileSync(path.join(output, "updated-canvas.png")));
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    let changedPixels = 0;
    for (let i = 0; i < a.data.length; i += 4)
      if (!a.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4))) changedPixels++;
    assert.equal(changedPixels, 0);
    const result = {
      objects: before.command.objects.map((o) => o.type),
      commandEqual: true,
      width: a.width,
      height: a.height,
      changedPixels,
      command: before.command
    };
    fs.writeFileSync(path.join(output, "compatibility.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ result: "PASS", commandEqual: true, changedPixels }));
    return;
  }
  assert(["sensors", "baseline", "updated"].includes(mode), "Use sensors, baseline, updated, or compare");
  let page;
  for (let i = 0; i < 120; i++) {
    try {
      page = (
        await (
          await fetch("http://127.0.0.1:" + (process.env.SCENE_PORT || 9222) + "/json/list", {
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
    const msg = JSON.parse(raw);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const seq = ++id;
      setTimeout(() => {
        if (pending.has(seq)) {
          console.error("CDP timeout", method);
          process.exit(1);
        }
      }, 15000).unref();
      pending.set(seq, resolve);
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
  const evaluate = async (expression) => {
    const msg = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert(!msg.result.exceptionDetails, JSON.stringify(msg));
    return msg.result.result.value;
  };
  try {
    for (let i = 0; i < 100; i++) {
      if (await evaluate("!!window.preferences && !!window.tabs && !!window.assets")) break;
      await wait(100);
    }
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 850, deviceScaleFactor: 1, mobile: false });
    await evaluate(
      `window.preferences={...window.preferences,theme:'light',field3dModeAc:'standard',field3dAntialiasing:false,timestamps:'original',hasScrolledTimeline:true};`
    );
    if (mode === "sensors") {
      const fixture = path.join(repoRoot, "src/hub/dataSources/ros2/fixtures/spatial-sensors.db3");
      await evaluate(
        `window.messagePort.onmessage({data:{name:'open-files',data:{files:[${JSON.stringify(fixture)}],merge:false}}})`
      );
      for (let i = 0; i < 150; i++) {
        if (await evaluate(`window.log.getFieldKeys().some(k=>k.endsWith('/range_min'))`)) break;
        await wait(100);
      }
      console.log(
        await evaluate(
          `JSON.stringify(window.log.getFieldKeys().filter(k=>window.log.getStructuredType(k)?.startsWith('sensor_msgs')))`
        )
      );
      console.log(await evaluate(`JSON.stringify(window.log.getTimestampRange())`));
    } else {
      await evaluate(
        `window.log.putNumber('compat2/clock',1,0);window.log.putNumber('compat2/clock',3,1);window.log.putRaw('compat2/pose',1,new Uint8Array([1]));window.log.putUnknownStruct('compat2/pose',1,{translation:{x:1,y:1,z:0.6},rotation:{q:{w:1,x:0,y:0,z:0}}});window.log.setStructuredType('compat2/pose','Pose3d');window.log.createBlankField('compat2/path',7);window.log.putUnknownStruct('compat2/path',1,[{translation:{x:-2,y:-1,z:.2},rotation:{q:{w:1,x:0,y:0,z:0}}},{translation:{x:0,y:2,z:.7},rotation:{q:{w:1,x:0,y:0,z:0}}},{translation:{x:2,y:1,z:1.2},rotation:{q:{w:1,x:0,y:0,z:0}}}]);window.log.setStructuredType('compat2/path','Pose3d[]');`
      );
    }
    await evaluate(
      `window.tabs.restoreState({selected:0,tabs:[{type:3,title:${JSON.stringify(
        mode === "sensors" ? "Laser scan and point cloud" : "Existing 3D views"
      )},controller:{game:'custom',sources:[],customEnvironment:{lengthMeters:10,widthMeters:8,originXMeters:-5,originYMeters:-4}},renderer:{cameraIndex:-1,orbitFov:50,cameraPosition:[9,8,10],cameraTarget:[0.1,0.1,0.1]},controlsHeight:220}]});window.selection.setTimelineRange([1,3],false);window.selection.setSelectedTime(1.5);`
    );
    if (mode !== "sensors")
      await evaluate(
        `window.tabs.tabList[0].controller.sourceList.setState([{logKey:'compat2/pose',logType:'Pose3d',type:'axes',visible:true,options:{}},{logKey:'compat2/pose',logType:'Pose3d',type:'cone',visible:true,options:{color:'#ff8c00',position:'center'}},{logKey:'compat2/path',logType:'Pose3d[]',type:'trajectory',visible:true,options:{color:'#2b66a2',size:'bold'}}]);`
      );
    if (mode === "sensors")
      await evaluate(
        `window.tabs.tabList[0].controller.sourceList.setState([{logKey:'/scan',logType:'sensor_msgs/msg/LaserScan',type:'laserScan',visible:true,options:{color:'#2166d1'}},{logKey:'/cloud',logType:'sensor_msgs/msg/PointCloud2',type:'pointCloud',visible:true,options:{color:'#ef6500'}}]);`
      );
    if (mode === "sensors")
      console.log(await evaluate(`JSON.stringify(window.tabs.tabList[0].controller.sourceList.getState())`));
    await wait(2500);
    const state = await evaluate(
      `JSON.stringify({command:window.tabs.tabList[0].controller.getCommand(),layout:window.tabs.saveState(),renderer:window.tabs.tabList[0].renderer.saveState(),alert:document.querySelector('.field-3d-alert')?.textContent})`
    );
    if (mode !== "sensors") {
      const command = JSON.parse(state).command;
      assert.equal(command.objects.find((o) => o.type === "trajectory").poses.length, 3);
      assert.deepEqual(command.objects.find((o) => o.type === "axes").poses[0].pose.rotation, [1, 0, 0, 0]);
    }
    fs.writeFileSync(path.join(output, mode + "-state.json"), state + "\n");
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, mode + ".png"), Buffer.from(shot.result.data, "base64"));
    const rect = await evaluate(
      `(()=>{const r=document.querySelector('.field-3d-canvas').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`
    );
    const canvas = await call("Page.captureScreenshot", { format: "png", clip: rect });
    fs.writeFileSync(path.join(output, mode + "-canvas.png"), Buffer.from(canvas.result.data, "base64"));
    if (mode === "sensors") {
      const observations = [];
      for (const time of [1.5, 2.5, 3, 1.5]) {
        await evaluate(`window.selection.setSelectedTime(${time})`);
        await wait(250);
        const observation = await evaluate(
          `(()=>{const tab=window.tabs.tabList[0];return {time:window.selection.getRenderTime(),objects:tab.renderer.implementation.objectManagers.filter(e=>e.type==='points').map(e=>({visible:e.manager.points.visible,count:e.manager.points.geometry.getAttribute('position')?.count??0,first:Array.from(e.manager.points.geometry.getAttribute('position')?.array.slice(0,3)??[])}))}})()`
        );
        assert.equal(observation.time, time);
        assert.deepEqual(
          observation.objects.map((o) => o.count),
          time === 3 ? [0, 0] : [181, 441]
        );
        assert.deepEqual(
          observation.objects.map((o) => o.visible),
          time === 3 ? [false, false] : [true, true]
        );
        observations.push(observation);
      }
      assert.equal(observations[0].objects[0].first[0], 3);
      assert(Math.abs(observations[1].objects[0].first[0] - 3.3) < 1e-6);
      assert(Math.abs(observations[1].objects[1].first[0] - 2.3) < 1e-6);
      const layout = await evaluate("window.tabs.saveState()");
      await evaluate(`window.tabs.restoreState(${JSON.stringify(layout)});window.selection.setSelectedTime(1.5)`);
      await wait(500);
      assert.deepEqual(
        await evaluate("window.tabs.tabList[0].controller.getCommand().objects.map(o=>o.positions.length/3)"),
        [181, 441]
      );
      fs.writeFileSync(
        path.join(output, "sensor-observations.json"),
        JSON.stringify({ observations, layout }, null, 2) + "\n"
      );
      console.log(
        JSON.stringify({
          result: "PASS",
          counts: observations.map((o) => o.objects.map((p) => p.count)),
          layoutRestored: true
        })
      );
    } else
      console.log(
        JSON.stringify({ result: "PASS", mode, objectTypes: JSON.parse(state).command.objects.map((o) => o.type) })
      );
  } finally {
    socket.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
