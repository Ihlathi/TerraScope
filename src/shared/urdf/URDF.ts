// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { DOMParser, type Element } from "@xmldom/xmldom";
import type { Pose3d, Rotation3d, Translation3d } from "../geometry";
import { composeFramePose } from "../log/FrameGraph";

export type URDFGeometry =
  | { type: "box"; size: Translation3d }
  | { type: "cylinder"; radius: number; length: number }
  | { type: "sphere"; radius: number }
  | { type: "mesh"; filename: string; scale: Translation3d };
export type URDFVisual = { origin: Pose3d; geometry: URDFGeometry; color: [number, number, number, number] };
export type URDFLink = { name: string; visuals: URDFVisual[] };
type JointBase = { name: string; parent: string; child: string; origin: Pose3d };
export type URDFJoint = JointBase &
  (
    | { type: "fixed" }
    | { type: "continuous"; axis: Translation3d }
    | { type: "revolute" | "prismatic"; axis: Translation3d; lower: number; upper: number }
  );
export type URDFRobot = { name: string; links: URDFLink[]; joints: URDFJoint[]; rootLinks: string[] };
export type URDFEdge = { child: string; parent: string; pose: Pose3d };

function children(element: Element, tag?: string): Element[] {
  const result: Element[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (!tag || node.nodeName === tag)) result.push(node as Element);
  }
  return result;
}

function one(element: Element, tag: string): Element | undefined {
  const found = children(element, tag);
  if (found.length > 1) throw new Error(`URDF has multiple <${tag}> elements in <${element.tagName}>.`);
  return found[0];
}

function required(element: Element, attribute: string): string {
  const value = element.getAttribute(attribute)?.trim();
  if (!value) throw new Error(`URDF <${element.tagName}> requires ${attribute}.`);
  return value;
}

function numbers(value: string, count: number): number[] {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== count || !parts.every(Number.isFinite))
    throw new Error(`Invalid URDF numeric value "${value}".`);
  return parts;
}

function triple(value: string | null | undefined, fallback: Translation3d): Translation3d {
  return value === null || value === undefined ? [...fallback] : (numbers(value, 3) as Translation3d);
}

function positive(element: Element, attribute: string): number {
  const value = numbers(required(element, attribute), 1)[0];
  if (value <= 0) throw new Error(`URDF ${attribute} must be positive.`);
  return value;
}

function origin(element: Element): Pose3d {
  const node = one(element, "origin");
  const translation = triple(node?.getAttribute("xyz"), [0, 0, 0]);
  const [r, p, y] = triple(node?.getAttribute("rpy"), [0, 0, 0]).map((v) => v / 2);
  const [cr, cp, cy, sr, sp, sy] = [Math.cos(r), Math.cos(p), Math.cos(y), Math.sin(r), Math.sin(p), Math.sin(y)];
  return {
    translation,
    rotation: [
      cr * cp * cy + sr * sp * sy,
      sr * cp * cy - cr * sp * sy,
      cr * sp * cy + sr * cp * sy,
      cr * cp * sy - sr * sp * cy
    ]
  };
}

function materialColor(element: Element): URDFVisual["color"] | undefined {
  const color = one(element, "color");
  if (!color) return undefined;
  const rgba = numbers(required(color, "rgba"), 4);
  if (!rgba.every((v) => v >= 0 && v <= 1)) throw new Error("URDF material rgba must be between 0 and 1.");
  return rgba as URDFVisual["color"];
}

function geometry(visual: Element): URDFGeometry {
  const container = one(visual, "geometry");
  const entries = container ? children(container) : [];
  if (entries.length !== 1) throw new Error("URDF visual requires exactly one geometry.");
  const shape = entries[0];
  switch (shape.tagName) {
    case "box": {
      const size = triple(required(shape, "size"), [1, 1, 1]);
      if (size.some((v) => v <= 0)) throw new Error("URDF box size must be positive.");
      return { type: "box", size };
    }
    case "cylinder":
      return { type: "cylinder", radius: positive(shape, "radius"), length: positive(shape, "length") };
    case "sphere":
      return { type: "sphere", radius: positive(shape, "radius") };
    case "mesh": {
      const scale = triple(shape.getAttribute("scale"), [1, 1, 1]);
      if (scale.some((v) => v === 0)) throw new Error("URDF mesh scale must be nonzero.");
      return { type: "mesh", filename: required(shape, "filename"), scale };
    }
    default:
      throw new Error(`Unsupported URDF geometry <${shape.tagName}>.`);
  }
}

export function parseURDF(xml: string): URDFRobot {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("URDF document types and entities are not supported.");
  const document = new DOMParser({
    onError: (level, message) => {
      throw new Error(`Invalid URDF XML (${level}): ${message}`);
    }
  }).parseFromString(xml, "text/xml");
  const robot = document.documentElement;
  if (!robot || robot.tagName !== "robot") throw new Error("URDF requires a <robot> root element.");
  const materials = new Map<string, URDFVisual["color"]>();
  for (const material of children(robot, "material")) {
    const color = materialColor(material);
    if (color) materials.set(required(material, "name"), color);
  }
  const linkNames = new Set<string>();
  const links = children(robot, "link").map((link): URDFLink => {
    const name = required(link, "name");
    if (linkNames.has(name)) throw new Error(`Duplicate URDF link "${name}".`);
    linkNames.add(name);
    return {
      name,
      visuals: children(link, "visual").map((visual) => {
        const material = one(visual, "material");
        const color = material
          ? materialColor(material) ?? materials.get(material.getAttribute("name") ?? "")
          : undefined;
        return { origin: origin(visual), geometry: geometry(visual), color: color ?? [0.65, 0.65, 0.7, 1] };
      })
    };
  });
  if (links.length === 0) throw new Error("URDF robot has no links.");
  const jointNames = new Set<string>();
  const parents = new Map<string, string>();
  const joints = children(robot, "joint").map((node): URDFJoint => {
    const name = required(node, "name");
    if (jointNames.has(name)) throw new Error(`Duplicate URDF joint "${name}".`);
    jointNames.add(name);
    const parentNode = one(node, "parent"),
      childNode = one(node, "child");
    if (!parentNode || !childNode) throw new Error(`URDF joint "${name}" requires parent and child links.`);
    const parent = required(parentNode, "link"),
      child = required(childNode, "link");
    if (!linkNames.has(parent) || !linkNames.has(child))
      throw new Error(`URDF joint "${name}" references an unknown link.`);
    if (parents.has(child)) throw new Error(`URDF link "${child}" has more than one parent.`);
    parents.set(child, parent);
    if (one(node, "mimic")) throw new Error(`URDF mimic joint "${name}" is not supported.`);
    const base = { name, parent, child, origin: origin(node) };
    const type = required(node, "type");
    if (type === "fixed") return { ...base, type };
    if (!["revolute", "continuous", "prismatic"].includes(type))
      throw new Error(`Unsupported URDF joint type "${type}".`);
    const axis = triple(one(node, "axis")?.getAttribute("xyz"), [1, 0, 0]);
    const norm = Math.hypot(...axis);
    if (norm === 0 || !Number.isFinite(norm)) throw new Error(`URDF joint "${name}" has a zero axis.`);
    const normalized = axis.map((v) => v / norm) as Translation3d;
    if (type === "continuous") return { ...base, type, axis: normalized };
    const limit = one(node, "limit");
    if (!limit) throw new Error(`URDF joint "${name}" requires limits.`);
    const lower = numbers(limit.getAttribute("lower") ?? "0", 1)[0],
      upper = numbers(limit.getAttribute("upper") ?? "0", 1)[0];
    if (lower > upper) throw new Error(`URDF joint "${name}" lower limit exceeds upper limit.`);
    return { ...base, type: type as "revolute" | "prismatic", axis: normalized, lower, upper };
  });
  for (const name of linkNames) {
    const seen = new Set<string>();
    let current: string | undefined = name;
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`URDF contains a cycle at link "${current}".`);
      seen.add(current);
      current = parents.get(current);
    }
  }
  const rootLinks = links.filter((link) => !parents.has(link.name)).map((link) => link.name);
  if (rootLinks.length !== 1) throw new Error("URDF must contain one connected link tree.");
  return { name: required(robot, "name"), links, joints, rootLinks };
}

export function jointPose(joint: URDFJoint, position: number): Pose3d {
  if (joint.type === "fixed") return joint.origin;
  const value = joint.type === "continuous" ? position : Math.max(joint.lower, Math.min(joint.upper, position));
  if (joint.type === "prismatic") {
    return composeFramePose(joint.origin, {
      translation: joint.axis.map((v) => v * value) as Translation3d,
      rotation: [1, 0, 0, 0]
    });
  }
  const rotation: Rotation3d = [
    Math.cos(value / 2),
    ...(joint.axis.map((v) => v * Math.sin(value / 2)) as Translation3d)
  ];
  return composeFramePose(joint.origin, { translation: [0, 0, 0], rotation });
}

export function urdfEdges(robot: URDFRobot, positions: ReadonlyMap<string, number>): URDFEdge[] {
  return robot.joints.map((joint) => ({
    child: joint.child,
    parent: joint.parent,
    pose: jointPose(joint, positions.get(joint.name) ?? 0)
  }));
}

export function resolveURDFMesh(
  filename: string,
  baseUrl: string | null,
  packageRootUrl: string | null
): { url: string } | { error: string } {
  try {
    let url: URL;
    if (filename.startsWith("package://")) {
      if (!packageRootUrl) return { error: `Unresolved mesh "${filename}". Choose a package root directory.` };
      const relative = filename.slice("package://".length);
      const parts = relative.split("/").map(decodeURIComponent);
      if (parts.length < 2 || parts.some((part) => !part || part === "." || part === ".." || /[\\/?#]/.test(part)))
        return { error: `Invalid package mesh path "${filename}".` };
      const root = new URL(packageRootUrl.endsWith("/") ? packageRootUrl : packageRootUrl + "/");
      url = new URL(parts.map(encodeURIComponent).join("/"), root);
    } else {
      if (!baseUrl && !/^[a-zA-Z][\w+.-]*:/.test(filename))
        return { error: `Unresolved relative mesh "${filename}". Load the URDF from a file.` };
      url = baseUrl ? new URL(filename, baseUrl) : new URL(filename);
    }
    if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost"))
      return { error: `Unresolved mesh "${filename}". Only local files are supported.` };
    if (!/\.(?:stl|dae)$/i.test(url.pathname)) return { error: `Unsupported mesh "${filename}". Use STL or DAE.` };
    return { url: url.href };
  } catch {
    return { error: `Invalid mesh path "${filename}".` };
  }
}
