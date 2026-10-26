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
const repo = process.env.IMAGE_REPO || path.resolve(__dirname, "../../..");
const output = process.env.IMAGE_OUTPUT || __dirname;
const baseline = process.env.IMAGE_BASELINE === "1";
const endpoint = `http://127.0.0.1:${process.env.IMAGE_PORT || 9222}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, description) {
  for (let i = 0; i < 150; i++) {
    const result = await check();
    if (result) return result;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    pending.get(message.id)?.(message);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, 20000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        pending.delete(id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    call,
    close: () => socket.close(),
    async evaluate(expression) {
      const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    async screenshot(name) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(output, name), Buffer.from(shot.data, "base64"));
    }
  };
}

const imageState = `(()=>{
  const image = document.querySelector('.image-renderer:not([hidden]) .image-frame');
  if (!image || image.hidden) return null;
  const canvas = image.tagName === 'CANVAS' ? image : document.createElement('canvas');
  if (image.tagName !== 'CANVAS') {
    if (!image.complete || !image.naturalWidth) return null;
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image,0,0);
  }
  return {tag:image.tagName,width:canvas.width,height:canvas.height,
    pixels:Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data),
    title:document.title};
})()`;
const frames =
  "new Promise(resolve=>{let count=0;function tick(){if(++count===8)resolve();else requestAnimationFrame(tick)}requestAnimationFrame(tick)})";

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const pages = async () => (await fetch(`${endpoint}/json/list`)).json();
  const page = await until(async () => (await pages()).find((p) => p.url.endsWith("/hub.html")), "Electron hub");
  const hub = await connect(page);
  const satellites = [];
  try {
    for (const existing of (await pages()).filter((page) => page.url.endsWith("/satellite.html"))) {
      await fetch(`${endpoint}/json/close/${existing.id}`);
    }
    await hub.call("Page.reload");
    await until(() => hub.evaluate("!!window.preferences && !!window.tabs && !!window.assets"), "hub startup");
    await hub.call("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 850,
      deviceScaleFactor: 1,
      mobile: false
    });
    await hub.evaluate(
      "window.preferences={...window.preferences,theme:'light',timestamps:'original',hasScrolledTimeline:true}"
    );
    const fixture = path.join(repo, "src/hub/dataSources/ros2/fixtures/images.db3");
    await hub.evaluate(
      `window.messagePort.onmessage({data:{name:'open-files',data:{files:[${JSON.stringify(fixture)}],merge:false}}})`
    );
    await until(() => hub.evaluate("window.log.getFieldKeys().includes('/camera/rgb8/data')"), "image bag reader");
    const source = [
      { logKey: "/camera/rgb8", logType: "sensor_msgs/msg/Image", type: "image", visible: true, options: {} }
    ];
    await hub.evaluate(
      `window.tabs.restoreState({selected:0,tabs:[{type:13,title:'ROS camera',controllerUUID:'image-evidence',controller:${JSON.stringify(
        source
      )},renderer:null,controlsHeight:180}]});window.selection.setTimelineRange([0,3.5],false);window.selection.setSelectedTime(1.5)`
    );
    await until(() => hub.evaluate(imageState), "first image frame");
    await hub.evaluate(
      `window.imageEvidence={updates:[],encodes:0};const originalSend=window.sendMainMessage;window.sendMainMessage=(name,data)=>{if(name==='update-satellite')window.imageEvidence.updates.push({id:data.command?.id,hasPixels:!!data.command?.image?.rgba,target:data.satelliteId??null,title:data.title});originalSend(name,data)};const encode=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){window.imageEvidence.encodes++;return encode.apply(this,args)}`
    );
    const observations = [];
    for (const time of [1.5, 2.5]) {
      await hub.evaluate(`window.selection.setSelectedTime(${time})`);
      await hub.evaluate(frames);
      const state = await hub.evaluate(imageState);
      const sample = Math.floor(time);
      assert.deepEqual(state.pixels, [
        10 + sample,
        40 + sample,
        90 + sample,
        255,
        110 + sample,
        140 + sample,
        190 + sample,
        255,
        20 + sample,
        50 + sample,
        100 + sample,
        255,
        120 + sample,
        150 + sample,
        200 + sample,
        255
      ]);
      observations.push({ time, ...state });
      if (!baseline) await hub.screenshot(`image-${time}.png`);
    }
    await hub.evaluate("window.tabs.newSatellite()");
    const satellitePage = await until(
      async () => (await pages()).find((p) => p.url.endsWith("/satellite.html")),
      "satellite window"
    );
    const satellite = await connect(satellitePage);
    satellites.push(satellite);
    await until(() => satellite.evaluate(imageState), "satellite pixels");
    assert.deepEqual((await satellite.evaluate(imageState)).pixels, observations[1].pixels);
    if (!baseline) await satellite.screenshot("image-satellite.png");
    await hub.evaluate("window.imageEvidence.updates=[]");
    await hub.evaluate(frames);
    const idle = await hub.evaluate("window.imageEvidence.updates");
    if (!baseline) assert.equal(idle.length, 0, "Unchanged image emits no satellite messages");
    await hub.evaluate("window.tabs.tabList[0].controller.restoreState([])");
    await hub.evaluate(frames);
    const firstEmptyId = await hub.evaluate("window.tabs.tabList[0].controller.getCommand().id");
    await hub.evaluate("window.imageEvidence.updates=[]");
    await hub.evaluate(frames);
    const empty = await hub.evaluate(
      "({id:window.tabs.tabList[0].controller.getCommand().id,updates:window.imageEvidence.updates})"
    );
    if (!baseline) {
      assert.equal(empty.id, firstEmptyId, "Unchanged empty state keeps command ID");
      assert.equal(empty.updates.length, 0, "Empty state is not resent");
    }
    await hub.evaluate(
      `window.tabs.tabList[0].controller.restoreState(${JSON.stringify(source)});window.selection.setSelectedTime(2.5)`
    );
    await hub.evaluate(frames);
    await hub.evaluate("window.imageEvidence.updates=[];window.tabs.renameTab(0,'ROS camera renamed')");
    await hub.evaluate(frames);
    const renamed = await hub.evaluate("window.imageEvidence.updates");
    if (!baseline) {
      assert.equal(renamed.length, 1);
      assert.equal(renamed[0].hasPixels, false, "Rename sends title without pixels");
      await until(async () => (await satellite.evaluate(imageState))?.title.includes("renamed"), "satellite title");
      await hub.evaluate("window.imageEvidence.updates=[];window.tabs.newSatellite()");
      const secondPage = await until(
        async () => (await pages()).find((p) => p.url.endsWith("/satellite.html") && p.id !== satellitePage.id),
        "second satellite"
      );
      const second = await connect(secondPage);
      satellites.push(second);
      await until(() => second.evaluate(imageState), "second satellite pixels");
      assert.deepEqual((await second.evaluate(imageState)).pixels, observations[1].pixels);
      await satellite.call("Page.reload");
      await until(() => satellite.evaluate(imageState), "reloaded satellite pixels");
      assert.deepEqual((await satellite.evaluate(imageState)).pixels, observations[1].pixels);
      await hub.evaluate("window.tabs.tabList[0].controller.restoreState([])");
      await hub.evaluate(frames);
      for (const destination of [hub, ...satellites]) {
        assert.equal(await destination.evaluate(imageState), null, "Source reset clears each renderer");
        assert.deepEqual(
          await destination.evaluate(
            "(()=>{const c=document.querySelector('.image-renderer:not([hidden]) .image-frame');return [c.width,c.height]})()"
          ),
          [0, 0],
          "Source reset releases canvas backing store"
        );
      }
    }
    if (!baseline) {
      await hub.evaluate(
        `window.tabs.addTab(13);window.tabs.tabList[1].controller.restoreState(${JSON.stringify(source)})`
      );
      await hub.evaluate(frames);
      assert(await hub.evaluate(imageState), "New image tab draws before close");
      await hub.evaluate(
        "window.closedImageCanvas=window.tabs.tabList[1].rendererElement.querySelector('.image-frame');window.tabs.close(1,true)"
      );
      assert.deepEqual(
        await hub.evaluate("[window.closedImageCanvas.width,window.closedImageCanvas.height]"),
        [0, 0],
        "Tab close releases canvas backing store"
      );
    }
    const evidence = await hub.evaluate("window.imageEvidence");
    if (!baseline) assert.equal(evidence.encodes, 0, "Display performs no PNG encoding");
    const report = { baseline, observations, idle, firstEmptyId, empty, renamed, pngEncodes: evidence.encodes };
    fs.writeFileSync(
      path.join(output, "ui-verification.json"),
      await require("prettier").format(JSON.stringify(report), { parser: "json", printWidth: 120 })
    );
    console.log(
      baseline
        ? `REPRO: idle updates=${idle.length}; empty ID changed=${firstEmptyId !== empty.id}; PNG encodes=${
            evidence.encodes
          }.`
        : "PASS: two cursor frames, actual satellite pixels, idle and empty dedupe, title-only update, second satellite, reload, source clear, tab close, and zero PNG encodes."
    );
  } finally {
    satellites.forEach((satellite) => satellite.close());
    hub.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
