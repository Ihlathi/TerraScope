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
const output = process.env.SCENE_OUTPUT || path.join(repo, "build/transform-tree");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  let page;
  for (let i = 0; i < 120; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${process.env.SCENE_PORT || 9222}/json/list`)).json()).find((p) =>
        p.url.endsWith("/hub.html")
      );
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
    const fixture = path.join(repo, "src/hub/dataSources/ros2/fixtures/transform-tree.db3");
    await evaluate(
      `window.messagePort.onmessage({data:{name:'open-files',data:{files:[${JSON.stringify(fixture)}],merge:false}}})`
    );
    for (let i = 0; i < 150; i++) {
      if (await evaluate("window.log.getFieldKeys().includes('/orphan_scan/header/frame_id')")) break;
      await wait(100);
    }
    assert(
      await evaluate("window.log.getFieldKeys().includes('/tf/transforms/0/child_frame_id')"),
      "Fixture opened through ROS 2 bag reader"
    );
    await evaluate(
      `window.tabs.restoreState({selected:0,tabs:[{type:3,title:'Transform tree',controller:{game:'custom',fixedFrame:'map',sources:[],customEnvironment:{lengthMeters:14,widthMeters:10,originXMeters:-5,originYMeters:-5}},renderer:{cameraIndex:-1,orbitFov:50,cameraPosition:[10,9,12],cameraTarget:[1,0,0]},controlsHeight:250}]});window.selection.setTimelineRange([1,3],false);window.selection.setSelectedTime(1.5)`
    );
    const sources = [
      {
        logKey: "/scan",
        logType: "sensor_msgs/msg/LaserScan",
        type: "laserScan",
        visible: true,
        options: { color: "#2166d1" }
      },
      {
        logKey: "/cloud",
        logType: "sensor_msgs/msg/PointCloud2",
        type: "pointCloud",
        visible: true,
        options: { color: "#ef6500" }
      }
    ];
    await evaluate(`window.tabs.tabList[0].controller.sourceList.setState(${JSON.stringify(sources)})`);
    await wait(2000);
    const observations = [];
    for (const time of [1.5, 2.5, 1.5]) {
      await evaluate(`window.selection.setSelectedTime(${time})`);
      await wait(400);
      const state = await evaluate(
        `(()=>{const tab=window.tabs.tabList[0];return {time:window.selection.getRenderTime(),command:tab.controller.getCommand(),points:tab.renderer.implementation.objectManagers.filter(e=>e.type==='points').map(e=>{const p=e.manager.points;return {visible:p.visible,count:p.geometry.getAttribute('position')?.count??0,localFirst:Array.from(p.geometry.getAttribute('position')?.array.slice(0,3)??[]),position:p.position.toArray(),quaternion:p.quaternion.toArray(),matrixWorld:p.matrixWorld.toArray()}}),alert:document.querySelector('.field-3d-frame-alert')?.textContent,alertHidden:document.querySelector('.field-3d-frame-alert')?.hidden}})()`
      );
      assert.equal(state.time, time);
      assert.equal(state.points.length, 2);
      assert.deepEqual(
        state.points.map((p) => p.count),
        [91, 3]
      );
      const expected = time === 1.5 ? [-1.5, -1, 0.25] : [2, 1.5, 0.25];
      const expectedQuaternion = time === 1.5 ? [0, 0, 0, 1] : [0, 0, Math.SQRT1_2, Math.SQRT1_2];
      for (const point of state.points) {
        point.position.forEach((value, axis) => assert(Math.abs(value - expected[axis]) < 1e-9));
        point.quaternion.forEach((value, axis) => assert(Math.abs(value - expectedQuaternion[axis]) < 1e-9));
      }
      assert(
        state.points.every((p) => p.visible && p.count > 0),
        "Both transformed sensors rendered"
      );
      assert(!state.command.frameDiagnostics?.length, "Connected frames have no diagnostic");
      observations.push(state);
      if (observations.length <= 2) {
        const shot = await call("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(output, `scan-${time}.png`), Buffer.from(shot.data, "base64"));
      }
    }
    assert.deepEqual(
      observations[0].points.map((p) => p.localFirst),
      observations[1].points.map((p) => p.localFirst),
      "Sensor payload stays constant while cursor moves"
    );
    assert.notDeepEqual(
      observations[0].points[0].matrixWorld,
      observations[1].points[0].matrixWorld,
      "Scan moves with its frame"
    );
    assert.deepEqual(observations[0].points, observations[2].points, "Rewind restores placement");
    sources.push({
      logKey: "/orphan_scan",
      logType: "sensor_msgs/msg/LaserScan",
      type: "laserScan",
      visible: true,
      options: { color: "#dc2655" }
    });
    await evaluate(
      `window.tabs.tabList[0].controller.sourceList.setState(${JSON.stringify(
        sources
      )});window.selection.setSelectedTime(2.5)`
    );
    await wait(400);
    const missing = await evaluate(
      `(()=>{const tab=window.tabs.tabList[0];const alert=document.querySelector('.field-3d-frame-alert');return {command:tab.controller.getCommand(),alert:alert?.textContent,hidden:alert?.hidden}})()`
    );
    assert(missing.command.frameDiagnostics?.length > 0, "Missing parent reported in command");
    assert.equal(missing.command.objects.filter((object) => object.type === "points")[2].positions.length, 0);
    assert.equal(missing.hidden, false, "Missing-parent indicator visible");
    assert.match(missing.alert, /orphan|missing|parent/i);
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, "missing-parent.png"), Buffer.from(shot.data, "base64"));
    const layout = await evaluate("window.tabs.saveState()");
    await evaluate(`window.tabs.restoreState(${JSON.stringify(layout)})`);
    await wait(400);
    assert.equal(
      await evaluate("window.tabs.tabList[0].controller.saveState().fixedFrame"),
      "map",
      "Fixed frame survives layout restore"
    );
    await evaluate(
      "window.log.putRaw('/framed_pose',1,new Uint8Array([1]));window.log.putUnknownStruct('/framed_pose',1,{header:{frame_id:'laser'},translation:{x:1,y:0,z:0},rotation:{q:{w:1,x:0,y:0,z:0}}});window.log.setStructuredType('/framed_pose','Pose3d');window.tabs.tabList[0].controller.sourceList.setState([{logKey:'/framed_pose',logType:'Pose3d',type:'axes',visible:true,options:{}}])"
    );
    const framedPoses = [];
    for (const time of [1.5, 2.5]) {
      await evaluate(`window.selection.setSelectedTime(${time})`);
      const command = await evaluate("window.tabs.tabList[0].controller.getCommand()");
      const pose = command.objects.find((object) => object.type === "axes").poses[0].pose;
      const expected = time === 1.5 ? [-0.5, -1, 0.25] : [2, 2.5, 0.25];
      pose.translation.forEach((value, axis) => assert(Math.abs(value - expected[axis]) < 1e-9));
      framedPoses.push({ time, pose });
    }
    await evaluate(
      "window.log.putRaw('/future_pose',2.8,new Uint8Array([4]));window.log.putUnknownStruct('/future_pose',2.8,{header:{frame_id:'laser'},translation:{x:1,y:0,z:0},rotation:{q:{w:1,x:0,y:0,z:0}}});window.log.setStructuredType('/future_pose','Pose3d');window.tabs.tabList[0].controller.sourceList.setState([{logKey:'/future_pose',logType:'Pose3d',type:'axes',visible:true,options:{}}]);window.selection.setSelectedTime(1.5)"
    );
    const futureCommand = await evaluate("window.tabs.tabList[0].controller.getCommand()");
    assert.equal(futureCommand.objects.find((object) => object.type === "axes").poses.length, 0);
    assert(futureCommand.frameDiagnostics.some((message) => message.includes("No source sample")));
    await evaluate(
      "window.log.putRaw('/future_components',2.8,new Uint8Array([5]));window.log.putUnknownStruct('/future_components',2.8,[{translation:{x:1,y:0,z:0},rotation:{q:{w:1,x:0,y:0,z:0}}}]);window.log.putString('/future_components/header/frame_id',2.8,'laser');window.log.setStructuredType('/future_components','Pose3d[]');window.tabs.tabList[0].controller.sourceList.setState([{logKey:'/framed_pose',logType:'Pose3d',type:'robot',visible:true,options:{model:'KitBot'}},{logKey:'/future_components',logType:'Pose3d[]',type:'component',visible:true,options:{}}])"
    );
    const futureComponentsCommand = await evaluate("window.tabs.tabList[0].controller.getCommand()");
    assert.equal(futureComponentsCommand.objects.find((object) => object.type === "robot").poses.length, 0);
    assert(futureComponentsCommand.frameDiagnostics.some((message) => message.includes("No source sample")));
    await evaluate(
      "window.log.putRaw('/vision_pose',1,new Uint8Array([2]));window.log.putUnknownStruct('/vision_pose',1,{header:{frame_id:'laser'},translation:{x:1,y:0,z:0},rotation:{q:{w:1,x:0,y:0,z:0}}});window.log.setStructuredType('/vision_pose','Pose3d');window.tabs.tabList[0].controller.sourceList.setState([{logKey:'/framed_pose',logType:'Pose3d',type:'robot',visible:true,options:{model:'KitBot'}},{logKey:'/vision_pose',logType:'Pose3d',type:'vision',visible:true,options:{color:'#2166d1',size:'normal'}},{logKey:'/vision_pose',logType:'Pose3d',type:'component',visible:true,options:{}}]);window.selection.setSelectedTime(2.5)"
    );
    const visionCommand = await evaluate("window.tabs.tabList[0].controller.getCommand()");
    const target = visionCommand.objects.find((object) => object.type === "robot").visionTargets[0].pose;
    target.translation.forEach((value, axis) => assert(Math.abs(value - [2, 2.5, 0.25][axis]) < 1e-9));
    const component = visionCommand.objects.find((object) => object.type === "robot").components[0];
    assert.equal(component.space, "scene");
    assert.deepEqual(component.value.pose, target);
    await evaluate("window.log.putString('/vision_pose/header/frame_id',1,'orphan_sensor')");
    const missingVisionCommand = await evaluate("window.tabs.tabList[0].controller.getCommand()");
    assert.equal(missingVisionCommand.objects.find((object) => object.type === "robot").visionTargets.length, 0);
    assert(missingVisionCommand.frameDiagnostics.some((message) => message.includes("missing_mount")));
    assert.equal(
      missingVisionCommand.objects.find((object) => object.type === "robot").components[0].space,
      "unresolved"
    );
    await evaluate(
      "window.log.putRaw('/rotation',1,new Uint8Array([3]));window.log.putUnknownStruct('/rotation',1,{header:{frame_id:'map'},q:{w:1,x:0,y:0,z:0}});window.log.setStructuredType('/rotation','Rotation3d');window.tabs.tabList[0].controller.sourceList.setState([{logKey:'/framed_pose',logType:'Pose3d',type:'robot',visible:true,options:{model:'KitBot'}},{logKey:'/rotation',logType:'Rotation3d',type:'rotationOverride',visible:true,options:{}}])"
    );
    const rotationCommand = await evaluate("window.tabs.tabList[0].controller.getCommand()");
    assert.deepEqual(
      rotationCommand.objects.find((object) => object.type === "robot").poses[0].pose.rotation,
      [1, 0, 0, 0],
      "Framed rotation override is already in scene coordinates"
    );
    await evaluate("window.log.putString('/rotation/header/frame_id',1,'orphan_sensor')");
    const missingRotationCommand = await evaluate("window.tabs.tabList[0].controller.getCommand()");
    assert.equal(missingRotationCommand.objects.find((object) => object.type === "robot").poses.length, 0);
    assert(missingRotationCommand.frameDiagnostics.some((message) => message.includes("missing_mount")));
    fs.writeFileSync(
      path.join(output, "observations.json"),
      JSON.stringify(
        {
          observations,
          missing,
          layout,
          framedPoses,
          futureCommand,
          futureComponentsCommand,
          visionCommand,
          missingVisionCommand,
          rotationCommand,
          missingRotationCommand
        },
        null,
        2
      ) + "\n"
    );
    console.log(
      "PASS: bag opened, constant scan and cloud move with dynamic frame, rewind restores placement, missing parent visible, fixed frame survives layout restore."
    );
  } finally {
    socket.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
