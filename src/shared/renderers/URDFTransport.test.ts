// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import Field3dSatellitePublisher, { Field3dSatelliteUpdate } from "../../hub/Field3dSatellitePublisher";
import { parseURDF } from "../urdf/URDF";
import { createUUID } from "../util";
import Field3dRenderer, { Field3dRendererCommand, Field3dRendererURDFModel } from "./Field3dRenderer";
import Field3dRendererImpl from "./Field3dRendererImpl";

function fixture() {
  const robot = parseURDF(
    '<robot name="transport"><link name="base"><visual><geometry><box size="1 1 1"/></geometry></visual></link></robot>'
  );
  const model: Field3dRendererURDFModel = { id: createUUID(), robot, baseUrl: null, packageRootUrl: null };
  const command: Field3dRendererCommand = {
    field: "custom",
    isRedAlliance: false,
    coordinateSystem: "center-red",
    objects: [
      {
        type: "urdf",
        modelId: model.id,
        links: [{ name: "base", pose: { translation: [0, 0, 0], rotation: [1, 0, 0, 0] } }]
      }
    ],
    cameraOverride: null,
    autoDriverStation: 0,
    allRobotModels: [],
    customEnvironment: null,
    customAssetUrl: null
  };
  return { model, command };
}

test("renderer change detection serializes only pose commands and applies model updates once", () => {
  const { model, command } = fixture();
  Object.defineProperty(model.robot, "toJSON", {
    value: () => {
      throw new Error("Robot serialized during frame change detection");
    }
  });
  const implementation: Field3dRendererImpl = Object.create(Field3dRendererImpl.prototype);
  Object.assign(globalThis, { window: { assets: null, matchMedia: () => ({ matches: false }), devicePixelRatio: 1 } });
  Object.assign(implementation, {
    clock: { getDelta: () => 0 },
    keysPressed: new Set(),
    controls: { update: () => false },
    renderer: { domElement: { clientWidth: 10, clientHeight: 10 } },
    canvas: { getBoundingClientRect: () => ({ width: 0 }) },
    lastAssets: null,
    lastFieldId: "custom",
    objectManagers: []
  });
  const renderer: Field3dRenderer = Object.create(Field3dRenderer.prototype);
  Object.assign(renderer, {
    implementation,
    urdfModel: null,
    updateImplementation: () => {},
    FRAME_ALERT: { textContent: "", hidden: true }
  });
  renderer.setURDFModel(model);
  renderer.render(command);
  const state = implementation as unknown as { lastCommandString: string; shouldRender: boolean };
  assert.equal(state.lastCommandString, JSON.stringify(command));
  assert.ok(!state.lastCommandString.includes('"geometry"'));
  state.shouldRender = false;
  renderer.setURDFModel(model);
  renderer.render(structuredClone(command));
  assert.equal(state.shouldRender, false, "unchanged model and cloned poses do not invalidate render state");
  renderer.setURDFModel({ ...model, id: "new-resource" });
  assert.equal(
    state.lastCommandString,
    "",
    "new model invalidates render state independently of command serialization"
  );
});

test("satellites clone model resources only on changes and replay them to new or reloaded windows", () => {
  const { model, command } = fixture();
  const updates: Field3dSatelliteUpdate[] = [];
  const publisher = new Field3dSatellitePublisher((update) => updates.push(structuredClone(update)));
  publisher.publish("tab", command, model, "Robot");
  for (let i = 0; i < 30; i++) publisher.publish("tab", structuredClone(command), model, "Robot");
  assert.equal(updates.filter((update) => Object.hasOwn(update, "urdfModel")).length, 1);
  for (const update of updates) {
    assert.ok(!JSON.stringify(update.command).includes('"geometry"'));
    const urdf = update.command.objects.find((object) => object.type === "urdf")!;
    assert.ok(!Object.hasOwn(urdf, "robot"));
    assert.equal(urdf.modelId, model.id);
  }
  publisher.publish("tab", command, model, "Robot", 42);
  assert.equal(updates.at(-1)!.satelliteId, 42);
  assert.equal(updates.at(-1)!.urdfModel!.id, model.id);
  publisher.publish("tab", command, model, "Robot");
  assert.ok(!Object.hasOwn(updates.at(-1)!, "urdfModel"), "targeted replay does not invalidate existing satellites");
  publisher.publish("tab", command, { ...model, id: "new" }, "Robot");
  assert.equal(updates.at(-1)!.urdfModel!.id, "new");
  publisher.publish("tab", { ...command, objects: [] }, null, "Robot");
  assert.equal(updates.at(-1)!.urdfModel, null);
  publisher.clear("tab");
  publisher.publish("tab", command, model, "Robot");
  assert.equal(updates.at(-1)!.urdfModel!.id, model.id, "reactivated tab resends its current model");
});

test("stopping a 3D renderer releases the current model and all visual managers", () => {
  const { model } = fixture();
  const implementation: Field3dRendererImpl = Object.create(Field3dRendererImpl.prototype);
  let disposed = 0;
  Object.assign(implementation, {
    urdfModel: model,
    objectManagers: [{ manager: { dispose: () => disposed++ } }, { manager: { dispose: () => disposed++ } }]
  });
  implementation.stop();
  assert.equal(disposed, 2);
  const state = implementation as unknown as { urdfModel: unknown; objectManagers: unknown[] };
  assert.equal(state.urdfModel, null);
  assert.deepEqual(state.objectManagers, []);
});

test("a cleared 3D satellite recreates its renderer and keeps diagnostics on the next command", () => {
  const { model, command } = fixture();
  const implementations: {
    stopped: boolean;
    frames: Field3dRendererCommand[];
    model: Field3dRendererURDFModel | null;
  }[] = [];
  class Implementation {
    state = { stopped: false, frames: [] as Field3dRendererCommand[], model: null as Field3dRendererURDFModel | null };
    constructor() {
      implementations.push(this.state);
    }
    setURDFModel(model: Field3dRendererURDFModel | null) {
      this.state.model = model;
    }
    stop() {
      this.state.stopped = true;
      this.state.model = null;
    }
    saveState() {
      return null;
    }
    restoreState() {}
    getAspectRatio() {
      return null;
    }
    getURDFDiagnostics() {
      return ["Mesh diagnostic"];
    }
    render(command: Field3dRendererCommand) {
      this.state.frames.push(command);
    }
  }
  const children: unknown[] = [];
  const canvas = () => ({ classList: { forEach: () => {}, add: () => {} }, id: "canvas", replaceWith() {} });
  const root = {
    getElementsByClassName(name: string) {
      return [
        name === "field-3d-canvas"
          ? canvas()
          : name === "field-3d-canvas-container"
          ? { appendChild: (child: unknown) => children.push(child) }
          : {}
      ];
    }
  };
  const file = "src/shared/renderers/Field3dRenderer.ts";
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "Field3dRenderer"
  )!;
  const script = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const Renderer = runInNewContext(script + "\nField3dRenderer", {
    exports: {},
    Field3dRendererImpl: Implementation,
    window: { preferences: { field3dModeAc: "standard", field3dAntialiasing: false } },
    document: {
      createElement: (tag: string) =>
        tag === "canvas" ? canvas() : { setAttribute() {}, hidden: true, textContent: "" }
    }
  }) as typeof Field3dRenderer;
  const renderer = new Renderer(root as unknown as HTMLElement);
  renderer.setURDFModel(model);
  renderer.render(command);
  renderer.dispose();
  assert.equal(implementations[0].stopped, true);
  renderer.setURDFModel(model);
  renderer.render(command);
  assert.equal(implementations.length, 2, "same preferences still recreate a disposed implementation");
  assert.equal(implementations[1].model, model);
  assert.deepEqual(implementations[1].frames, [command]);
  assert.equal(children.length, 1, "the existing diagnostic element remains attached");
  assert.equal((children[0] as { textContent: string }).textContent, "Mesh diagnostic");
});
