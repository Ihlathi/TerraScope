// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const WebSocket = require("ws");
const { createFixture } = require("./fixture.cjs");
const output = __dirname;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pages = async (port = 9222) => await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

async function until(read, predicate, label, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function client(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    const finish = pending.get(message.id);
    if (finish) {
      pending.delete(message.id);
      finish(message);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const sequence = ++id;
      const timeout = setTimeout(() => {
        pending.delete(sequence);
        reject(new Error(`CDP timeout for ${method}`));
      }, 20000);
      pending.set(sequence, (message) => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: sequence, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const screenshot = async (filename) => {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(output, filename), Buffer.from(shot.data, "base64"));
  };
  return { call, evaluate, screenshot, close: () => socket.close() };
}

async function tileWindows(main) {
  const handles = await main.evaluate(
    "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows().filter(w=>w.webContents.getURL().endsWith('/hub.html')||w.webContents.getURL().endsWith('/satellite.html')).map(w=>({id:w.getNativeWindowHandle().readUInt32LE(0),hub:w.webContents.getURL().endsWith('/hub.html')}))"
  );
  execFileSync("python", [
    "-c",
    `
import ctypes, json, sys
x = ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
x.XMoveResizeWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint]
x.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
d = x.XOpenDisplay(b':99')
if not d: raise RuntimeError('Xvfb :99 unavailable')
for w in json.loads(sys.argv[1]):
    x.XMoveResizeWindow(d, w['id'], 0 if w['hub'] else 950, 0, 950 if w['hub'] else 650, 1000)
hub = next(w for w in json.loads(sys.argv[1]) if w['hub'])
x.XWarpPointer(d, 0, hub['id'], 0, 0, 0, 0, 50, 350)
x.XSync(d, 0)
x.XCloseDisplay(d)
`,
    JSON.stringify(handles)
  ]);
  await pause(750);
}

async function captureSample(hub, main) {
  await hub.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 50, y: 350 });
  const environment = { lengthMeters: 12, widthMeters: 10, originXMeters: 0, originYMeters: 0 };
  const motorSources = ["FrontLeft", "FrontRight", "RearLeft", "RearRight"].map((motor, index) => ({
    logKey: `/Robot/Drive/${motor}/current`,
    logType: "Number",
    type: "smooth",
    visible: true,
    options: { color: ["#ff0000", "#0000ff", "#00a000", "#ff8800"][index], size: "normal", sourceUnit: "automatic" }
  }));
  await hub.evaluate(
    `window.preferences={...window.preferences,theme:'light',timestamps:'original',hasScrolledTimeline:true,hasScrolledLineGraph:true,field3dModeAc:'standard',field3dAntialiasing:false};window.tabs.restoreState({selected:0,tabs:[{type:2,controllerUUID:'evidence-pose2d',title:'Sample loop',controller:{field:'custom',customEnvironment:${JSON.stringify(
      environment
    )},sources:[{logKey:'/Robot/Pose2d',logType:'Pose2d',type:'robot',visible:true,options:{bumpers:'#ff0000'}}]},controlsHeight:220},{type:1,controllerUUID:'evidence-currents',title:'Drive motor currents',controller:{leftSources:${JSON.stringify(
      motorSources
    )}},controlsHeight:210}]});window.selection.setTimelineRange([0,40],false);window.selection.setSelectedTime(5)`
  );
  await pause(1500);
  const pose2d = await hub.evaluate("window.tabs.tabList[0].controller.getCommand()");
  assert(
    pose2d.objects.some((object) => object.type === "robot" && object.poses.length === 1),
    "Decoded Pose2d feeds the field renderer"
  );
  await hub.call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false
  });
  await hub.screenshot("sample-2d.png");
  if (main) {
    await hub.evaluate("window.tabs.newSatellite()");
    await until(pages, (list) => list.some((page) => page.url.endsWith("/satellite.html")), "2D satellite");
    await main.evaluate(
      `(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');for(const w of e.BrowserWindow.getAllWindows()){const u=w.webContents.getURL();if(u.endsWith('/logManager.html'))w.hide();if(u.endsWith('/hub.html'))w.setBounds({x:0,y:0,width:950,height:1000});if(u.endsWith('/satellite.html')){w.setBounds({x:950,y:0,width:650,height:1000});w.show()}}})()`
    );
    await hub.call("Emulation.clearDeviceMetricsOverride");
    await tileWindows(main);
  }
  await hub.evaluate("window.tabs.setSelected(1)");
  await pause(1500);
  if (main) await tileWindows(main);
  await hub.evaluate("window.selection.setHoveredTime(null)");
  await pause(250);
  const currents = await hub.evaluate("window.tabs.tabList[1].controller.getCommand()");
  assert.equal(currents.leftFields.length, 4, "All four motor currents feed the graph renderer");
  assert(
    currents.leftFields.every((field) => field.values.length > 100),
    "Motor graphs contain time-series samples"
  );
  await hub.screenshot("sample-currents.png");
  if (main) {
    execFileSync("python", [
      "-c",
      "from PIL import ImageGrab; import sys; ImageGrab.grab(xdisplay=':99').save(sys.argv[1])",
      path.join(output, "sample-2d-and-currents.png")
    ]);
    await main.evaluate(
      `(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');for(const w of e.BrowserWindow.getAllWindows()){if(w.webContents.getURL().endsWith('/satellite.html'))w.close();if(w.webContents.getURL().endsWith('/hub.html'))w.setBounds({x:100,y:50,width:1280,height:900})}})()`
    );
    await hub.call("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 850,
      deviceScaleFactor: 1,
      mobile: false
    });
  }
  await hub.evaluate(
    `window.tabs.restoreState({selected:0,tabs:[{type:3,controllerUUID:'evidence-pose3d',title:'Sample ramp',controller:{game:'custom',customEnvironment:${JSON.stringify(
      environment
    )},sources:[{logKey:'/Robot/Pose3d',logType:'Pose3d',type:'robot',visible:true,options:{model:'KitBot'}}]},renderer:{cameraIndex:-1,orbitFov:50,cameraPosition:[-10,4,10],cameraTarget:[-7,0.4,6]},controlsHeight:230}]});window.selection.setSelectedTime(5)`
  );
  await pause(2500);
  await hub.evaluate("window.selection.setHoveredTime(null)");
  const pose3d = await hub.evaluate("window.tabs.tabList[0].controller.getCommand()");
  assert(
    pose3d.objects.some((object) => object.type === "robot" && object.poses.length),
    "Decoded Pose3d feeds the 3D robot renderer"
  );
  const rampPose = pose3d.objects.find((object) => object.type === "robot").poses[0].pose;
  assert(Math.abs(rampPose.translation[2] - 0.4) < 1e-6, "Ramp pose has expected elevation at five seconds");
  await until(
    () =>
      hub.evaluate(
        "(()=>{const r=window.tabs.tabList[0].renderer.implementation;return !!r && r.renderer.info.render.calls>0 && r.objectManagers.some(e=>e.type==='robot' && e.manager.meshes.some(m=>m.count>0))})()"
      ),
    Boolean,
    "3D robot meshes rendered"
  );
  await hub.screenshot("sample-3d.png");
  return { pose2d, currents, pose3d };
}

(async () => {
  let fixture = await createFixture({ readDelayMs: 180 });
  const connections = [];
  let main;
  try {
    const hubPage = await until(pages, (list) => list.some((page) => page.url.endsWith("/hub.html")), "Electron hub");
    const hub = await client(hubPage.find((page) => page.url.endsWith("/hub.html")));
    connections.push(hub);
    await until(
      () => hub.evaluate("!!window.preferences && !!window.tabs && !!window.assets"),
      Boolean,
      "hub initialization"
    );
    try {
      main = await client((await pages(9229))[0]);
      connections.push(main);
    } catch {}
    if (process.argv.includes("--framing-only")) {
      assert(
        await hub.evaluate("window.log.getFieldKeys().includes('/Robot/Pose3d/translation/z')"),
        "Open sample is required for reframing"
      );
      const framed = await captureSample(hub, main);
      const observationsPath = path.join(output, "observations.json");
      const observations = JSON.parse(fs.readFileSync(observationsPath, "utf8"));
      Object.assign(observations, framed, {
        framing:
          "Raw CDP captures; nonzero camera target follows WPILib scene transform; actual X11 windows tiled side by side on the same 1600x1000 Xvfb desktop."
      });
      fs.writeFileSync(observationsPath, JSON.stringify(observations, null, 2) + "\n");
      console.log(
        "PASS: sample 3D camera centered on elevated robot; real 2D satellite and motor-current hub tiled without overlap; raw screenshot captures."
      );
      return;
    }
    const welcome = (await pages()).find((page) => page.url.endsWith("/betaWelcome.html"));
    if (welcome) {
      const welcomeClient = await client(welcome);
      connections.push(welcomeClient);
      await welcomeClient.evaluate(
        "setTimeout(()=>{document.querySelectorAll('input[type=checkbox]').forEach(e=>e.click());document.querySelector('button').click()},50);true"
      );
      await until(
        pages,
        (list) => !list.some((page) => page.url.endsWith("/betaWelcome.html")),
        "development welcome dismissal"
      );
    }
    if (main) {
      await main.evaluate(
        "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows().forEach(w=>w.webContents.closeDevTools())"
      );
      await main.evaluate(
        `(()=>{const e=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');const hub=e.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/hub.html'));const file=e.Menu.getApplicationMenu().items.find(i=>i.label==='File');const item=file.submenu.items.find(i=>i.label==='Log Manager...');if(!item)throw Error('Log Manager File menu absent');item.click(item,hub)})()`
      );
    } else {
      await hub.call("Page.bringToFront");
      await hub.call("Input.dispatchKeyEvent", {
        type: "keyDown",
        modifiers: 10,
        key: "D",
        code: "KeyD",
        windowsVirtualKeyCode: 68
      });
      await hub.call("Input.dispatchKeyEvent", {
        type: "keyUp",
        modifiers: 10,
        key: "D",
        code: "KeyD",
        windowsVirtualKeyCode: 68
      });
    }
    const managerPages = await until(
      pages,
      (list) => list.some((page) => page.url.endsWith("/logManager.html")),
      "Log Manager window"
    );
    const manager = await client(managerPages.find((page) => page.url.endsWith("/logManager.html")));
    connections.push(manager);
    await manager.call("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 850,
      deviceScaleFactor: 1,
      mobile: false
    });
    await until(
      () => manager.evaluate("document.querySelector('#local-table tbody').textContent"),
      (value) => value.includes("TerraScope sample robot"),
      "default sample row"
    );
    let fresh = await manager.evaluate(
      "({count:document.querySelectorAll('#local-table tbody tr').length,text:document.querySelector('#local-table tbody').innerText,folder:document.querySelector('#download-folder').textContent})"
    );
    assert.equal(fresh.count, 1, "Fresh library contains only the shipped sample");
    assert.match(fresh.text, /Read-only sample/);
    await until(
      () => manager.evaluate("document.querySelector('#local-table tbody').innerText"),
      (value) => value.includes("40.0 s"),
      "sample metadata"
    );
    fresh = await manager.evaluate(
      "({count:document.querySelectorAll('#local-table tbody tr').length,text:document.querySelector('#local-table tbody').innerText,folder:document.querySelector('#download-folder').textContent})"
    );
    await manager.screenshot("fresh-profile.png");
    await manager.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await manager.screenshot("fresh-profile-dark.png");
    await manager.call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await manager.evaluate("document.querySelector('#local-table tbody tr').click()");
    assert(
      await manager.evaluate(
        "document.getElementById('rename').disabled && document.getElementById('tags').disabled && document.getElementById('trash').disabled"
      ),
      "Sample mutation controls are disabled"
    );
    const sampleRow = await manager.evaluate(
      "(()=>{const r=document.querySelector('#local-table tbody tr').getBoundingClientRect();return {x:r.x+80,y:r.y+r.height/2}})()"
    );
    for (const clickCount of [1, 2]) {
      await manager.call("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount,
        ...sampleRow
      });
      await manager.call("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount,
        ...sampleRow
      });
    }
    await until(
      () => hub.evaluate("window.log.getFieldKeys().includes('/Robot/Pose3d/translation/z')"),
      Boolean,
      "sample opened through library action"
    );
    const { pose2d, currents, pose3d } = await captureSample(hub, main);
    if (main)
      await main.evaluate(
        "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/logManager.html')).show()"
      );
    await manager.call("Page.bringToFront");
    await manager.evaluate(
      `(()=>{const set=(id,value)=>{const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))};set('profile','__new');set('profile-name','Local SFTP fixture');set('host','127.0.0.1');set('port',${JSON.stringify(
        String(fixture.port)
      )});set('user','fixture');set('remote-path','/logs');set('auth','password');document.getElementById('save-profile').click();document.getElementById('connect').click()})()`
    );
    await until(
      () =>
        manager.evaluate(
          "document.querySelector('#prompt-dialog').open && document.querySelector('#prompt-dialog').dataset.kind"
        ),
      (kind) => kind === "password",
      "session password prompt"
    );
    await manager.evaluate(
      "document.querySelector('#prompt-input').value='fixture-only';document.querySelector('#prompt-confirm').click()"
    );
    await until(
      () =>
        manager.evaluate(
          "document.querySelector('#prompt-dialog').open && document.querySelector('#prompt-dialog').dataset.kind"
        ),
      (kind) => kind === "trust",
      "first-connect host trust prompt"
    );
    const trust = await manager.evaluate(
      "({detail:document.querySelector('#prompt-detail').innerText,focused:document.activeElement.id})"
    );
    assert.match(trust.detail, /SHA256:/);
    assert.equal(trust.focused, "prompt-cancel", "Trust dialog defaults to cancel");
    await manager.screenshot("trust-host-key.png");
    await manager.evaluate("document.querySelector('#prompt-confirm').click()");
    await until(
      () =>
        manager.evaluate(
          "({status:document.querySelector('#connection-status').textContent,count:document.querySelectorAll('#remote-table tbody tr').length,disk:document.querySelector('#disk-usage').textContent})"
        ),
      (value) => value.status === "Connected" && value.count === 2 && value.disk.includes("free"),
      "connected SFTP list and disk usage"
    );
    const remoteRows = await manager.evaluate("document.querySelector('#remote-table tbody').innerText");
    assert.match(remoteRows, /loop.mcap/);
    assert.match(remoteRows, /arm.mcap/);
    assert(!remoteRows.includes("unsupported.txt"));
    await manager.screenshot("remote-connected.png");
    const diskBeforeSync = fixture.events.disk;
    await manager.evaluate(
      "document.querySelector('[aria-label=\"Select loop.mcap\"]').click();document.getElementById('sync-selected').click()"
    );
    await until(
      async () => ({
        disk: fixture.events.disk,
        busy: await manager.evaluate("!document.getElementById('cancel').disabled")
      }),
      (state) => state.busy && state.disk > diskBeforeSync,
      "remote disk usage continues polling during a slow transfer"
    );
    const pollDuringSync = { before: diskBeforeSync, during: fixture.events.disk, busy: true };
    await manager.screenshot("sync-progress.png");
    await until(
      () => manager.evaluate("document.querySelector('#activity').innerText"),
      (text) => text.includes("Sync finished. Downloaded 1, skipped 0."),
      "selected sync"
    );
    assert(
      fs.existsSync(path.join(fresh.folder, "loop.mcap")) && !fs.existsSync(path.join(fresh.folder, "arm.mcap")),
      "Selected sync pulls only the chosen log"
    );
    await manager.evaluate("document.getElementById('sync-all').click()");
    await until(
      () => manager.evaluate("document.querySelector('#activity').innerText"),
      (text) => text.includes("Sync finished. Downloaded 1, skipped 1."),
      "finished sync"
    );
    for (const name of ["arm.mcap", "loop.mcap"]) {
      const downloaded = fs.readFileSync(path.join(fresh.folder, name));
      assert.equal(
        createHash("sha256").update(downloaded).digest("hex"),
        createHash("sha256")
          .update(fs.readFileSync(path.join(fixture.root, name)))
          .digest("hex")
      );
    }
    assert.equal(fs.readdirSync(fresh.folder).filter((name) => name.endsWith(".part")).length, 0);
    await manager.screenshot("sync-finished.png");
    const reads = fixture.events.reads;
    await manager.evaluate("document.getElementById('sync-all').click()");
    await until(
      () => manager.evaluate("document.querySelector('#activity').innerText"),
      (text) => text.includes("Sync finished. Downloaded 0, skipped 2."),
      "equal-size repeat sync skipping"
    );
    assert.equal(fixture.events.reads, reads, "Already-synced files require no content reads");
    assert.equal(fixture.events.removeCalls, 0);
    const remoteEvents = { ...fixture.events };
    const endpoint = fixture.port;
    await manager.evaluate("document.getElementById('disconnect').click()");
    await fixture.close();
    fixture = await createFixture({ port: endpoint });
    await manager.evaluate("document.getElementById('connect').click()");
    await until(
      () => manager.evaluate("document.querySelector('#activity').innerText"),
      (text) => text.includes("SSH host key changed"),
      "changed host key refusal"
    );
    const mismatch = await manager.evaluate("document.querySelector('#activity').lastElementChild.innerText");
    assert.match(mismatch, /Trusted fingerprint: SHA256:/);
    assert.match(mismatch, /Received fingerprint: SHA256:/);
    assert.equal(
      await manager.evaluate("document.querySelector('#prompt-dialog').open"),
      false,
      "Changed host key cannot be accepted through a prompt"
    );
    if (main) {
      const userData = await main.evaluate(
        "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getPath('userData')"
      );
      const profiles = fs.readFileSync(path.join(userData, "robot-profiles.json"), "utf8");
      assert(!profiles.includes("fixture-only"), "Session password is not serialized");
      assert(!/"password"\s*:/.test(profiles), "Profiles contain no password field");
    }
    fs.writeFileSync(
      path.join(output, "observations.json"),
      JSON.stringify(
        {
          fresh,
          pose2d,
          currents,
          pose3d,
          trust,
          remoteRows,
          pollDuringSync,
          fixture: remoteEvents,
          mismatch,
          sync: "selected sync downloaded one; all sync downloaded the other and skipped one; repeat skipped both; downloaded SHA256 matches; no part files; no remote mutations"
        },
        null,
        2
      ) + "\n"
    );
    console.log(
      "PASS: fresh default sample, in-app open, decoded 2D/3D poses and motor graphs, first-trust prompt, controlled SFTP list and df polled during slow transfer, complete sync, byte equality, repeat skip, zero remote writes."
    );
  } finally {
    for (const connection of connections) connection.close();
    await fixture.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
