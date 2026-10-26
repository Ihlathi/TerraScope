// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { BuiltIn3dFields } from "../../shared/AdvantageScopeAssets";
import {
  CUSTOM_FIELD_ID,
  CustomEnvironment,
  DEFAULT_CUSTOM_ENVIRONMENT,
  parseCustomEnvironment
} from "../../shared/CustomEnvironment";
import { SourceListItemState, SourceListOptionValueConfig, SourceListState } from "../../shared/SourceListConfig";
import { IS_LITE } from "../../shared/buildConstants";
import {
  APRIL_TAG_16H5_COUNT,
  APRIL_TAG_36H11_COUNT,
  AnnotatedPose3d,
  ModuleVelocity,
  Pose3d,
  grabHeatmapData,
  grabModuleVelocities,
  grabPosesAuto,
  rotationSequenceToQuaternion
} from "../../shared/geometry";
import { composeFramePose, frameGraphForSource, readSourceFrame, transformTopics } from "../../shared/log/FrameGraph";
import Log from "../../shared/log/Log";
import { MechanismState, getMechanismState, mergeMechanismStates } from "../../shared/log/LogMechanismState";
import { getOrDefault } from "../../shared/log/LogUtil";
import LoggableType from "../../shared/log/LoggableType";
import { ALLIANCE_KEYS, DRIVER_STATION_KEYS, getDriverStation, getIsRedAlliance } from "../../shared/log/RobotState";
import { SemanticType, canReadAsPose, classifyStructuredType } from "../../shared/log/SemanticType";
import { readSensorPoints } from "../../shared/log/SpatialSensor";
import {
  Field3dRendererCommand,
  Field3dRendererCommand_AnyObj,
  Field3dRendererCommand_Component
} from "../../shared/renderers/Field3dRenderer";
import { URDFRobot, parseURDF, urdfEdges } from "../../shared/urdf/URDF";
import { inURDFScope, readURDFJointPositions, urdfScope, valueAtURDFTime } from "../../shared/urdf/URDFLog";
import { clampValue, createUUID } from "../../shared/util";
import SourceList from "../SourceList";
import Field3dController_Config from "./Field3dController_Config";
import TabController, { setupKeyboardControls } from "./TabController";

export default class Field3dController implements TabController {
  UUID = createUUID();

  private XR_BUTTON: HTMLButtonElement;
  private FIELD_SELECT: HTMLSelectElement;
  private SETTINGS: HTMLElement;
  private LENGTH_INPUT: HTMLInputElement;
  private WIDTH_INPUT: HTMLInputElement;
  private ORIGIN_X_INPUT: HTMLInputElement;
  private ORIGIN_Y_INPUT: HTMLInputElement;
  private ASSET_INPUT: HTMLInputElement;
  private FIXED_FRAME_INPUT: HTMLInputElement;

  private URDF_SELECT: HTMLSelectElement;
  private JOINT_SELECT: HTMLSelectElement;
  private URDF_STATUS: HTMLElement;
  private PACKAGE_NAME: HTMLElement;
  private urdfFile: { xml: string; url: string; name: string; reference?: string } | null = null;
  private packageRootReference: string | null = null;
  private meshBaseReference: string | null = null;
  private urdfTopics: { log: Log; descriptions: string[]; joints: string[] } | null = null;
  private urdfOptionsDirty = true;
  private packageRootUrl: string | null = null;
  private meshBaseUrl: string | null = null;
  private RESOURCE_NAME: HTMLElement;
  private urdfXML: string | null = null;
  private urdfRobot: URDFRobot | null = null;
  private urdfError: string | null = null;
  private urdfLoadError: string | null = null;
  private sourceList: SourceList;
  private environment: CustomEnvironment = { ...DEFAULT_CUSTOM_ENVIRONMENT };
  private assetUrl: string | null = null;

  constructor(root: HTMLElement) {
    this.sourceList = new SourceList(
      root.getElementsByClassName("field-3d-sources")[0] as HTMLElement,
      Field3dController_Config,
      []
    );
    this.SETTINGS = root.getElementsByClassName("field-3d-settings")[0] as HTMLElement;
    this.XR_BUTTON = this.SETTINGS.getElementsByClassName("xr-button")[0] as HTMLButtonElement;
    this.URDF_SELECT = this.SETTINGS.querySelector(".urdf-description") as HTMLSelectElement;
    this.JOINT_SELECT = this.SETTINGS.querySelector(".urdf-joints") as HTMLSelectElement;
    this.URDF_STATUS = this.SETTINGS.querySelector(".urdf-status") as HTMLElement;
    this.PACKAGE_NAME = this.SETTINGS.querySelector(".urdf-package-name") as HTMLElement;
    this.RESOURCE_NAME = this.SETTINGS.querySelector(".urdf-resource-name") as HTMLElement;
    for (const [selector, kind] of [
      [".urdf-load", "robot"],
      [".urdf-packages", "packages"],
      [".urdf-resources", "resources"]
    ]) {
      const button = this.SETTINGS.querySelector(selector) as HTMLButtonElement;
      button.disabled = IS_LITE;
      if (IS_LITE) button.title = "Local URDF resources require the desktop app.";
      button.addEventListener("click", () => window.sendMainMessage("urdf-pick", { uuid: this.UUID, kind }));
    }
    const onPicked = (event: Event) => {
      if (!root.isConnected) {
        window.removeEventListener("urdf-picked", onPicked);
        return;
      }
      const data = (event as CustomEvent).detail;
      if (data?.uuid !== this.UUID) return;
      if (typeof data.error === "string") {
        this.urdfLoadError = data.error;
        this.URDF_STATUS.textContent = data.error;
        return;
      }
      this.urdfLoadError = null;
      if (
        data.kind === "robot" &&
        typeof data.xml === "string" &&
        typeof data.url === "string" &&
        typeof data.name === "string"
      ) {
        this.urdfFile = { xml: data.xml, url: data.url, name: data.name, reference: data.reference };
        this.urdfOptionsDirty = true;
        this.updateURDFOptions();
        if (!data.restoring) this.URDF_SELECT.value = "file";
      } else if (data.kind === "packages" && typeof data.url === "string") {
        this.packageRootUrl = data.url;
        this.packageRootReference = data.reference ?? null;
        this.PACKAGE_NAME.textContent = data.url;
      } else if (data.kind === "resources" && typeof data.url === "string") {
        this.meshBaseUrl = data.url;
        this.meshBaseReference = data.reference ?? null;
        this.RESOURCE_NAME.textContent = data.url;
      }
    };
    window.addEventListener("urdf-picked", onPicked);

    this.FIELD_SELECT = this.SETTINGS.getElementsByClassName("field-select")[0] as HTMLSelectElement;
    this.LENGTH_INPUT = this.SETTINGS.getElementsByClassName("custom-length")[0] as HTMLInputElement;
    this.WIDTH_INPUT = this.SETTINGS.getElementsByClassName("custom-width")[0] as HTMLInputElement;
    this.ORIGIN_X_INPUT = this.SETTINGS.getElementsByClassName("custom-origin-x")[0] as HTMLInputElement;
    this.ORIGIN_Y_INPUT = this.SETTINGS.getElementsByClassName("custom-origin-y")[0] as HTMLInputElement;
    this.FIXED_FRAME_INPUT = this.SETTINGS.getElementsByClassName("fixed-frame")[0] as HTMLInputElement;
    this.ASSET_INPUT = this.SETTINGS.getElementsByClassName("custom-asset")[0] as HTMLInputElement;
    this.ASSET_INPUT.addEventListener("change", () => {
      this.replaceAssetUrl(this.ASSET_INPUT.files?.[0] ?? null);
    });
    (this.SETTINGS.getElementsByClassName("custom-asset-clear")[0] as HTMLButtonElement).addEventListener(
      "click",
      () => {
        this.ASSET_INPUT.value = "";
        this.replaceAssetUrl(null);
      }
    );

    // Set up XR button
    if (IS_LITE) {
      Array.from(this.SETTINGS.getElementsByClassName("xr-control")).forEach((element) => {
        let htmlElement = element as HTMLElement;
        htmlElement.parentElement?.removeChild(htmlElement);
      });
    }
    setupKeyboardControls(this.XR_BUTTON);
    this.XR_BUTTON.addEventListener("click", () => {
      window.sendMainMessage("open-xr", this.UUID);
    });

    // Set up game select
    this.FIELD_SELECT.addEventListener("change", () => {
      let isFTC = [...(window.assets === null ? [] : window.assets.field3ds), ...BuiltIn3dFields].find(
        (game) => game.id === this.FIELD_SELECT.value
      )?.isFTC;
      if (isFTC !== undefined) {
        if (window.preferences) window.preferences.prefersFTC = isFTC;
        window.sendMainMessage("update-preferences", { prefersFTC: isFTC });
      }
      this.updateFieldDependentControls();
    });
    this.updateFieldOptions();
    this.updateRobotOptions();
  }

  /** Sets whether XR streamling is currently active for this tab. */
  setXRActive(active: boolean) {
    if (active) {
      this.XR_BUTTON.classList.add("active");
    } else {
      this.XR_BUTTON.classList.remove("active");
    }
  }

  /** Updates field select with the latest options. */
  private updateFieldOptions() {
    let value = this.FIELD_SELECT.value;
    let frcGroup = this.fieldGroup("FRC Fields");
    let ftcGroup = this.fieldGroup("FTC Fields");
    while (frcGroup.firstChild) {
      frcGroup.removeChild(frcGroup.firstChild);
    }
    while (ftcGroup.firstChild) {
      ftcGroup.removeChild(ftcGroup.firstChild);
    }
    let options: string[] = [];
    if (window.assets !== null) {
      [...window.assets.field3ds, ...BuiltIn3dFields].forEach((field) => {
        let option = document.createElement("option");
        option.innerText = field.name;
        option.value = field.id;
        options.push(field.id);
        (field.isFTC ? ftcGroup : frcGroup).appendChild(option);
      });
    }
    options.push(CUSTOM_FIELD_ID);
    if (options.includes(value)) {
      this.FIELD_SELECT.value = value;
    } else {
      this.selectDefaultField();
    }
    this.updateFieldDependentControls();
  }

  /** Selects the default field based on whether the user prefers FTC. */
  private selectDefaultField() {
    let prefersFTC = window.preferences?.prefersFTC ?? false;
    let primaryGroup = prefersFTC ? this.fieldGroup("FTC Fields") : this.fieldGroup("FRC Fields");
    let secondaryGroup = prefersFTC ? this.fieldGroup("FRC Fields") : this.fieldGroup("FTC Fields");

    if (primaryGroup.children.length > 0) {
      this.FIELD_SELECT.value = (primaryGroup.children[0] as HTMLOptionElement).value;
    } else if (secondaryGroup.children.length > 0) {
      this.FIELD_SELECT.value = (secondaryGroup.children[0] as HTMLOptionElement).value;
    } else {
      this.FIELD_SELECT.selectedIndex = 0;
    }
  }

  private fieldGroup(label: string): HTMLOptGroupElement {
    return this.FIELD_SELECT.querySelector(`optgroup[label="${label}"]`) as HTMLOptGroupElement;
  }

  private readEnvironment(): CustomEnvironment {
    let parsed = parseCustomEnvironment(
      Number(this.LENGTH_INPUT.value),
      Number(this.WIDTH_INPUT.value),
      Number(this.ORIGIN_X_INPUT.value),
      Number(this.ORIGIN_Y_INPUT.value)
    );
    if (parsed) this.environment = parsed;
    return this.environment;
  }

  private writeEnvironment(env: CustomEnvironment) {
    this.environment = env;
    this.LENGTH_INPUT.value = env.lengthMeters.toString();
    this.WIDTH_INPUT.value = env.widthMeters.toString();
    this.ORIGIN_X_INPUT.value = env.originXMeters.toString();
    this.ORIGIN_Y_INPUT.value = env.originYMeters.toString();
  }

  private replaceAssetUrl(file: File | null) {
    if (this.assetUrl) URL.revokeObjectURL(this.assetUrl);
    this.assetUrl = file ? URL.createObjectURL(file) : null;
  }

  /** Updates source list with the latest robot models. */
  private updateRobotOptions() {
    if (window.assets === null) return;
    let fieldConfig = [...window.assets.field3ds, ...BuiltIn3dFields].find(
      (game) => game.id === this.FIELD_SELECT.value
    );
    let isFTC = fieldConfig !== undefined && fieldConfig.isFTC;
    let robotList: string[] = [];
    if (window.assets !== null) {
      robotList = window.assets.robots.filter((robot) => robot.isFTC === isFTC).map((robot) => robot.name);
    }
    if (robotList.length === 0) {
      robotList.push("KitBot");
    }
    let sourceListValues: SourceListOptionValueConfig[] = robotList.map((name) => {
      return { key: name, display: name };
    });
    this.sourceList.setOptionValues("robot", "model", sourceListValues);
    this.sourceList.setOptionValues("ghost", "model", sourceListValues);
  }

  /** Updates the robots, source button, and other options based on the selected value. */
  private updateFieldDependentControls() {
    this.SETTINGS.classList.toggle("custom-open", this.FIELD_SELECT.value === CUSTOM_FIELD_ID);
    if (window.assets === null) return;
    let fieldConfig = [...window.assets.field3ds, ...BuiltIn3dFields].find(
      (game) => game.id === this.FIELD_SELECT.value
    );

    // Update game piece options
    let gamePieces: string[] = [];
    if (fieldConfig !== undefined) {
      gamePieces = fieldConfig.gamePieces.map((x) => x.name);
    }
    if (gamePieces.length === 0) {
      gamePieces.push("None");
    }
    let sourceListValues: SourceListOptionValueConfig[] = gamePieces.map((name) => {
      return { key: name, display: name };
    });
    this.sourceList.setOptionValues("gamePiece", "variant", sourceListValues);

    // Update AprilTag variants
    let aprilTagVariants: { key: string; display: string }[] = fieldConfig?.isFTC
      ? [
          { key: "36h11-2in", display: "2 in" },
          { key: "36h11-3in", display: "3 in" },
          { key: "36h11-3.25in", display: "3.25 in" },
          { key: "36h11-4in", display: "4 in" },
          { key: "36h11-5in", display: "5 in" },
          { key: "36h11-6.5in", display: "6.5 in" }
        ]
      : [
          { key: "36h11-6.5in", display: "36h11" },
          { key: "16h5-6in", display: "16h5" }
        ];
    this.sourceList.setOptionValues("aprilTag", "variant", aprilTagVariants);

    this.updateRobotOptions();
  }

  private discoverURDFTopics() {
    if (this.urdfTopics?.log === window.log) return this.urdfTopics;
    const descriptions: string[] = [];
    const joints: string[] = [];
    for (const key of window.log.getFieldKeys()) {
      if (
        /(?:^|\/)robot_description$/.test(key) &&
        (window.log.getType(key) === LoggableType.String || window.log.getType(key + "/data") === LoggableType.String)
      )
        descriptions.push(key);
      if (["sensor_msgs/msg/JointState", "sensor_msgs/JointState"].includes(window.log.getStructuredType(key) ?? ""))
        joints.push(key);
    }
    this.urdfOptionsDirty = true;
    return (this.urdfTopics = { log: window.log, descriptions, joints });
  }

  private updateURDFOptions() {
    const topics = this.discoverURDFTopics();
    if (!this.urdfOptionsDirty) return;
    this.urdfOptionsDirty = false;
    const update = (select: HTMLSelectElement, options: { value: string; label: string }[]) => {
      const value = select.value;
      if (value && !options.some((option) => option.value === value))
        options.push({ value, label: `${value} (unavailable)` });
      if (
        JSON.stringify(Array.from(select.options).map((option) => [option.value, option.text])) ===
        JSON.stringify(options.map((option) => [option.value, option.label]))
      )
        return;
      select.replaceChildren(
        ...options.map(({ value, label }) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          return option;
        })
      );
      select.value = value;
      if (select.selectedIndex === -1) select.selectedIndex = 0;
    };
    update(this.URDF_SELECT, [
      { value: "", label: "None" },
      ...(this.urdfFile ? [{ value: "file", label: this.urdfFile.name }] : []),
      ...topics.descriptions.map((key) => ({ value: key, label: key }))
    ]);
    update(this.JOINT_SELECT, [
      { value: "", label: "Automatic" },
      ...topics.joints.map((key) => ({ value: key, label: key }))
    ]);
  }

  saveState(): unknown {
    return {
      sources: this.sourceList.getState(),
      game: this.FIELD_SELECT.value,
      customEnvironment: this.readEnvironment(),
      fixedFrame: this.FIXED_FRAME_INPUT.value,
      urdf: {
        file: this.urdfFile?.reference ? { reference: this.urdfFile.reference, name: this.urdfFile.name } : null,
        description: this.URDF_SELECT.value,
        joints: this.JOINT_SELECT.value,
        packageRoot: this.packageRootReference,
        meshBase: this.meshBaseReference
      }
    };
  }

  restoreState(state: unknown): void {
    if (typeof state !== "object" || state === null) return;

    this.updateFieldOptions();
    this.FIXED_FRAME_INPUT.value =
      "fixedFrame" in state && typeof state.fixedFrame === "string" ? state.fixedFrame : "";
    if ("sources" in state) {
      this.sourceList.setState(state.sources as SourceListState);
    }
    if ("game" in state && typeof state.game === "string") {
      this.FIELD_SELECT.value = state.game;
      if (this.FIELD_SELECT.value === "") {
        this.selectDefaultField();
      }
    }
    if ("customEnvironment" in state) {
      let custom = state.customEnvironment;
      if (typeof custom === "object" && custom !== null) {
        let parsed = parseCustomEnvironment(
          Number("lengthMeters" in custom ? custom.lengthMeters : NaN),
          Number("widthMeters" in custom ? custom.widthMeters : NaN),
          Number("originXMeters" in custom ? custom.originXMeters : NaN),
          Number("originYMeters" in custom ? custom.originYMeters : NaN)
        );
        if (parsed) this.writeEnvironment(parsed);
      }
    }
    if ("urdf" in state && typeof state.urdf === "object" && state.urdf !== null) {
      const config = state.urdf;
      this.urdfFile = null;
      this.packageRootReference = null;
      this.meshBaseReference = null;
      this.packageRootUrl = null;
      this.meshBaseUrl = null;
      this.PACKAGE_NAME.textContent = "";
      this.RESOURCE_NAME.textContent = "";
      if (
        "file" in config &&
        typeof config.file === "object" &&
        config.file !== null &&
        "xml" in config.file &&
        typeof config.file.xml === "string" &&
        "url" in config.file &&
        typeof config.file.url === "string" &&
        "name" in config.file &&
        typeof config.file.name === "string"
      )
        this.urdfFile = { xml: config.file.xml, url: config.file.url, name: config.file.name };
      if (
        "file" in config &&
        typeof config.file === "object" &&
        config.file !== null &&
        "reference" in config.file &&
        typeof config.file.reference === "string"
      )
        window.sendMainMessage("urdf-restore", { uuid: this.UUID, kind: "robot", reference: config.file.reference });
      else if (this.urdfFile)
        window.sendMainMessage("urdf-restore", { uuid: this.UUID, kind: "robot", url: this.urdfFile.url });
      for (const [property, kind] of [
        ["packageRoot", "packages"],
        ["meshBase", "resources"]
      ] as const) {
        if (property in config && typeof (config as Record<string, unknown>)[property] === "string")
          window.sendMainMessage("urdf-restore", {
            uuid: this.UUID,
            kind,
            reference: (config as Record<string, unknown>)[property]
          });
      }
      if ("packageRootUrl" in config && typeof config.packageRootUrl === "string") {
        this.packageRootUrl = config.packageRootUrl;
        this.PACKAGE_NAME.textContent = config.packageRootUrl;
        window.sendMainMessage("urdf-restore", { uuid: this.UUID, kind: "packages", url: config.packageRootUrl });
      }
      if ("meshBaseUrl" in config && typeof config.meshBaseUrl === "string") {
        this.meshBaseUrl = config.meshBaseUrl;
        this.RESOURCE_NAME.textContent = config.meshBaseUrl;
        window.sendMainMessage("urdf-restore", { uuid: this.UUID, kind: "resources", url: config.meshBaseUrl });
      }
      this.urdfOptionsDirty = true;
      this.updateURDFOptions();
      const restoreSelect = (select: HTMLSelectElement, value: unknown) => {
        if (typeof value !== "string") return;
        if (value && !Array.from(select.options).some((option) => option.value === value)) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = `${value} (unavailable)`;
          select.appendChild(option);
        }
        select.value = value;
      };
      if ("description" in config) restoreSelect(this.URDF_SELECT, config.description);
      if ("joints" in config) restoreSelect(this.JOINT_SELECT, config.joints);
    }
    this.updateFieldDependentControls();
  }

  refresh(): void {
    this.urdfTopics = null;
    this.sourceList.refresh();
  }

  newAssets(): void {
    this.updateFieldOptions();
    this.updateRobotOptions();
  }

  getActiveFields(): string[] {
    return [
      ...this.sourceList.getActiveFields(),
      ...transformTopics(window.log),
      ...(this.URDF_SELECT.value
        ? [...this.discoverURDFTopics().descriptions, ...this.discoverURDFTopics().joints]
        : []),
      ...ALLIANCE_KEYS,
      ...DRIVER_STATION_KEYS
    ];
  }

  showTimeline(): boolean {
    return true;
  }

  getCommand(): Field3dRendererCommand {
    // Get timestamp
    let time = window.selection.getRenderTime();

    // Get field data
    let customEnvironment = this.FIELD_SELECT.value === CUSTOM_FIELD_ID ? this.readEnvironment() : null;
    let fieldData = customEnvironment
      ? undefined
      : [...(window.assets === null ? [] : window.assets.field3ds), ...BuiltIn3dFields].find(
          (game) => game.id === this.FIELD_SELECT.value
        );
    let coordinateSystem = customEnvironment
      ? "center-red"
      : (window.preferences?.coordinateSystem === "automatic"
          ? fieldData?.coordinateSystem
          : window.preferences?.coordinateSystem) ?? "center-red";

    // Get alliance
    let isRedAlliance = time === null ? false : getIsRedAlliance(window.log, time);

    let objects: Field3dRendererCommand_AnyObj[] = [];
    const frameDiagnostics: string[] = [];
    this.updateURDFOptions();
    const description = this.URDF_SELECT.value;
    const xml =
      description === "file"
        ? this.urdfFile?.xml
        : description && time !== null
        ? valueAtURDFTime(
            window.log,
            window.log.getType(description) === LoggableType.String ? description : description + "/data",
            time
          )
        : null;
    if (xml !== this.urdfXML) {
      this.urdfXML = typeof xml === "string" ? xml : null;
      this.urdfRobot = null;
      this.urdfError = null;
      if (typeof xml === "string") {
        try {
          this.urdfRobot = parseURDF(xml);
        } catch (error) {
          this.urdfError = String(error);
        }
      }
    }
    const robot = description ? this.urdfRobot : null;
    const allJointTopics = description ? this.discoverURDFTopics().joints : [];
    const jointTopic =
      this.JOINT_SELECT.value ||
      allJointTopics.find((key) => description === "file" || inURDFScope(key, urdfScope(description))) ||
      "";
    const scope = urdfScope(description === "file" ? jointTopic : description);
    const jointSample = robot
      ? readURDFJointPositions(
          window.log,
          jointTopic && inURDFScope(jointTopic, scope) ? [jointTopic] : [],
          time ?? -Infinity
        )
      : { positions: new Map<string, number>(), diagnostics: [] };
    const edges = robot ? urdfEdges(robot, jointSample.positions) : [];
    const robotGraph = robot
      ? frameGraphForSource(window.log, description === "file" ? jointTopic || "/" : description)
      : null;
    const graphEdges = (key: string) =>
      inURDFScope(key, scope) && frameGraphForSource(window.log, key) === robotGraph ? edges : [];
    if (description) {
      if (this.urdfError) frameDiagnostics.push(`URDF: ${this.urdfError}`);
      else if (!robot) frameDiagnostics.push("URDF: No robot_description sample at this time.");
      if (robot) frameDiagnostics.push(...robot.diagnostics, ...jointSample.diagnostics);
      if (robot && jointTopic && !inURDFScope(jointTopic, scope))
        frameDiagnostics.push(`URDF: JointState topic "${jointTopic}" is outside the description namespace.`);
    }
    this.URDF_STATUS.textContent =
      this.urdfLoadError ??
      this.urdfError ??
      (robot
        ? `${robot.name}. ${robot.links.length} links. ${
            jointTopic || "No JointState topic; joints use zero."
          } ${robot.diagnostics.join(" ")}`
        : "");
    if (robot && robotGraph) {
      const graph = robotGraph;
      const fixed = this.FIXED_FRAME_INPUT.value.trim() || graph.defaultFixedFrame(edges) || robot.rootLinks[0];
      this.FIXED_FRAME_INPUT.placeholder = fixed;
      objects.push({
        type: "urdf",
        robot,
        baseUrl: description === "file" ? this.urdfFile!.url : this.meshBaseUrl,
        packageRootUrl: this.packageRootUrl,
        links: robot.links.map((link) => {
          const result = graph.resolve(link.name, fixed, time ?? -Infinity, edges);
          if (result.status === "resolved") return { name: link.name, pose: result.pose };
          frameDiagnostics.push(`URDF link "${link.name}": ${result.status} "${result.frame}".`);
          return { name: link.name, pose: null };
        })
      });
    }

    const sourceTransform = (key: string): Pose3d | null | undefined => {
      if (time === null) return undefined;
      const frame = readSourceFrame(window.log, key, time);
      if (frame === null) return undefined;
      if (frame === undefined) {
        frameDiagnostics.push(`${key}: No source sample at this time.`);
        return null;
      }
      const graph = frameGraphForSource(window.log, key);
      const fixedFrame =
        this.FIXED_FRAME_INPUT.value.trim() ||
        graph.defaultFixedFrame(graphEdges(key)) ||
        (inURDFScope(key, scope) ? robot?.rootLinks[0] : "") ||
        "";
      this.FIXED_FRAME_INPUT.placeholder = fixedFrame || "Select a frame";
      const result = graph.resolve(frame, fixedFrame, time, graphEdges(key));
      if (result.status === "resolved") return result.pose;
      const reason = {
        "missing-parent": "Missing parent",
        unavailable: "No transform at this time",
        invalid: "Invalid transform",
        cycle: "Transform cycle"
      }[result.status];
      frameDiagnostics.push(
        `${key}: ${reason} "${result.frame}". Frame "${frame}" to "${fixedFrame || "(select fixed frame)"}".`
      );
      return null;
    };
    let cameraOverride: AnnotatedPose3d | null = null;
    let sources = this.sourceList.getState(true);
    for (let i = 0; i < sources.length; i++) {
      let source = sources[i];
      let typeConfig = Field3dController_Config.types.find((typeConfig) => typeConfig.key === source.type);
      if (typeConfig?.childOf !== undefined) continue; // This is a child, don't render

      // Find children
      let children: SourceListItemState[] = [];
      while (
        sources.length > i + 1 &&
        Field3dController_Config.types.find((typeConfig) => typeConfig.key === sources[i + 1].type)?.childOf !==
          undefined
      ) {
        i++;
        children.push(sources[i]);
      }

      if (source.type === "laserScan" || source.type === "pointCloud") {
        const transform = sourceTransform(source.logKey);
        objects.push({
          type: "points",
          color: source.options.color,
          positions:
            time === null || transform === null ? [] : readSensorPoints(window.log, source.logKey, time, this.UUID),
          ...(transform ? { pose: transform } : {})
        });
        continue;
      }

      // Get pose data
      let isHeatmap = source.type === "heatmap";
      let poses: AnnotatedPose3d[] = [];

      if (!isHeatmap) {
        if (time !== null && canReadAsPose(source.logType)) {
          poses = grabPosesAuto(window.log, source.logKey, source.logType, time, this.UUID);
        }
      } else {
        let timeRange: "enabled" | "auto" | "teleop" | "teleop-no-endgame" | "full" | "visible" = "enabled";
        if ("timeRange" in source.options) {
          let timeRangeRaw = source.options.timeRange;
          timeRange =
            timeRangeRaw === "enabled" ||
            timeRangeRaw === "auto" ||
            timeRangeRaw === "teleop" ||
            timeRangeRaw === "teleop-no-endgame" ||
            timeRangeRaw === "full" ||
            timeRangeRaw === "visible"
              ? timeRangeRaw
              : "enabled";
        }
        if (canReadAsPose(source.logType)) {
          poses = grabHeatmapData(window.log, source.logKey, source.logType, timeRange, this.UUID);
        }
      }

      const transform = sourceTransform(source.logKey);
      if (transform === null) poses = [];
      else if (transform) poses = poses.map((value) => ({ ...value, pose: composeFramePose(transform, value.pose) }));

      // Add data from children
      let components: Field3dRendererCommand_Component[] = [];
      let mechanismsXZ: MechanismState[] = [];
      let mechanismsYZ: MechanismState[] = [];
      let visionTargets: AnnotatedPose3d[] = [];
      let swerveModuleVelocities: {
        values: ModuleVelocity[];
        color: string;
      }[] = [];
      if (time !== null) {
        children.forEach((child) => {
          switch (child.type) {
            case "component": {
              if (canReadAsPose(child.logType)) {
                const childTransform = sourceTransform(child.logKey);
                const childPoses = grabPosesAuto(window.log, child.logKey, child.logType, time!, this.UUID);
                if (childTransform === null && childPoses.length === 0) poses = [];
                childPoses.forEach((value) => {
                  components.push(
                    childTransform === null
                      ? { space: "unresolved" }
                      : childTransform
                      ? { space: "scene", value: { ...value, pose: composeFramePose(childTransform, value.pose) } }
                      : value
                  );
                });
              }
              break;
            }

            case "mechanism": {
              if (classifyStructuredType(child.logType) !== SemanticType.MechanismJoint) break;
              let state = getMechanismState(window.log, child.logKey, time!);
              if (state !== null) {
                (child.options.plane === "yz" ? mechanismsYZ : mechanismsXZ).push(state);
              }
              break;
            }

            case "rotationOverride":
            case "rotationOverrideLegacy": {
              let numberRotationUnits: "radians" | "degrees" = "radians";
              if ("units" in child.options) {
                numberRotationUnits = child.options.units === "degrees" ? "degrees" : "radians";
              }
              let rotations = canReadAsPose(child.logType)
                ? grabPosesAuto(window.log, child.logKey, child.logType, time!, this.UUID, numberRotationUnits)
                : [];
              const childTransform = sourceTransform(child.logKey);
              if (childTransform === null) poses = [];
              else if (rotations.length > 0) {
                const rotationTransform = childTransform ?? transform;
                const rotation = rotationTransform
                  ? composeFramePose(rotationTransform, rotations[0].pose).rotation
                  : rotations[0].pose.rotation;
                poses.forEach((value) => {
                  value.pose.rotation = rotation;
                });
              }
              break;
            }

            case "vision": {
              let newVisionTargets = canReadAsPose(child.logType)
                ? grabPosesAuto(window.log, child.logKey, child.logType, time!, this.UUID)
                : [];
              const childTransform = sourceTransform(child.logKey);
              if (childTransform === null) newVisionTargets = [];
              else if (childTransform)
                newVisionTargets = newVisionTargets.map((value) => ({
                  ...value,
                  pose: composeFramePose(childTransform, value.pose)
                }));
              newVisionTargets.forEach((annotatedPose) => {
                annotatedPose.annotation.visionColor = child.options.color;
                annotatedPose.annotation.visionSize = child.options.size;
              });
              visionTargets = visionTargets.concat(newVisionTargets);
              break;
            }

            case "swerveModuleVelocities": {
              let states = grabModuleVelocities(window.log, child.logKey, time!, child.options.arrangement, this.UUID);
              swerveModuleVelocities.push({
                values: states,
                color: child.options.color
              });
              break;
            }

            case "aprilTagIDs": {
              let values: number[] = getOrDefault(
                window.log,
                child.logKey,
                LoggableType.NumberArray,
                time!,
                [],
                this.UUID
              );
              let tagCount =
                typeof source.options.variant === "string" && source.options.variant.startsWith("16h5")
                  ? APRIL_TAG_16H5_COUNT
                  : APRIL_TAG_36H11_COUNT;
              values.forEach((id) => {
                id = clampValue(Math.floor(id), 0, tagCount - 1);
                let index = poses.findIndex((value) => value.annotation.aprilTagId === undefined);
                if (index !== -1) {
                  poses[index].annotation.aprilTagId = id;
                }
              });
              break;
            }
          }
        });
      }
      let mechanismXZ = mechanismsXZ.length === 0 ? null : mergeMechanismStates(mechanismsXZ);
      let mechanismYZ = mechanismsYZ.length === 0 ? null : mergeMechanismStates(mechanismsYZ);
      visionTargets.reverse();
      swerveModuleVelocities.reverse();

      // Add object
      switch (source.type) {
        case "robot":
          objects.push({
            type: "robot",
            model: source.options.model,
            poses: poses,
            components: components,
            mechanisms: {
              xz: mechanismXZ,
              yz: mechanismYZ
            },
            visionTargets: visionTargets,
            swerveModuleVelocities: swerveModuleVelocities
          });
          break;
        case "ghost":
          objects.push({
            type: "ghost",
            color: source.options.color,
            model: source.options.model,
            poses: poses,
            components: components,
            mechanisms: {
              xz: mechanismXZ,
              yz: mechanismYZ
            },
            visionTargets: visionTargets,
            swerveModuleVelocities: swerveModuleVelocities
          });
          break;
        case "gamePiece":
          objects.push({
            type: "gamePiece",
            variant: source.options.variant,
            poses: poses
          });
          break;
        case "trajectory":
          objects.push({
            type: "trajectory",
            color: source.options.color,
            size: source.options.size,
            poses: poses
          });
          break;
        case "heatmap":
          objects.push({
            type: "heatmap",
            poses: poses
          });
          break;
        case "aprilTag":
          const variantRaw = source.options.variant as string;
          const parts = variantRaw.split("-");
          const family = parts[0] as "36h11" | "16h5";
          const inches = parseFloat(parts[1]);
          objects.push({
            type: "aprilTag",
            poses: poses,
            variant: { family, inches }
          });
          break;
        case "axes":
          objects.push({
            type: "axes",
            poses: poses
          });
          break;
        case "cone":
          let positionRaw = source.options.position;
          let position: "center" | "back" | "front" =
            positionRaw === "center" || positionRaw === "back" || positionRaw === "front" ? positionRaw : "center";
          objects.push({
            type: "cone",
            color: source.options.color,
            position: position,
            poses: poses
          });
          break;
        case "cameraOverride":
          if (cameraOverride === null) {
            cameraOverride = poses[0];
          }
          break;
      }
    }

    // Add built-in AprilTag objects
    if (fieldData !== undefined) {
      new Set(fieldData.aprilTags.map((x) => x.variant)).forEach((variant) => {
        const parts = variant.split("-");
        const family = parts[0] as "36h11" | "16h5";
        const inches = parseFloat(parts[1]);

        objects.push({
          type: "aprilTagBuiltIn",
          poses: fieldData.aprilTags
            .filter((x) => x.variant === variant)
            .map((aprilTag) => {
              let quaternion = rotationSequenceToQuaternion(aprilTag.rotations);
              let annotatedPose: AnnotatedPose3d = {
                pose: {
                  translation: aprilTag.position,
                  rotation: [quaternion.w, quaternion.x, quaternion.y, quaternion.z]
                },
                annotation: {
                  is2DSource: false,
                  aprilTagId: aprilTag.id
                }
              };
              return annotatedPose;
            }),
          variant: { family, inches }
        });
      });
    }

    // Get all robot models
    let allRobotModels: Set<string> = new Set();
    let allSources = this.sourceList.getState();
    allSources.forEach((source) => {
      if (["robot", "ghost"].includes(source.type)) {
        allRobotModels.add(source.options.model);
      }
    });

    return {
      field: customEnvironment ? CUSTOM_FIELD_ID : this.FIELD_SELECT.value,
      isRedAlliance: isRedAlliance,
      coordinateSystem: coordinateSystem,
      objects: objects,
      cameraOverride: cameraOverride,
      autoDriverStation: getDriverStation(window.log, time!),
      allRobotModels: [...allRobotModels],
      customEnvironment: customEnvironment,
      customAssetUrl: customEnvironment ? this.assetUrl : null,
      ...(frameDiagnostics.length ? { frameDiagnostics } : {})
    };
  }
}
