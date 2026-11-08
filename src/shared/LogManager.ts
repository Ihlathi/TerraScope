// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

export type RobotAuth =
  | { kind: "agent" }
  | { kind: "key"; keyPath: string }
  | { kind: "password" }
  | { kind: "factory"; preset: "roborio" | "systemcore" };

export interface RobotProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  remotePath: string;
  auth: RobotAuth;
}

export interface LogMetadata {
  robot?: string;
  date?: number;
  duration?: number;
  error?: string;
}

export interface LibraryEntry extends LogMetadata {
  path: string;
  name: string;
  size: number;
  mtime: number;
  format: string;
  tags: string[];
  missing: boolean;
  readOnly: boolean;
}

export interface RemoteLog {
  name: string;
  size: number;
  modified: number;
}

export interface LogManagerState {
  profiles: RobotProfile[];
  folders: string[];
  downloadFolder: string;
  library: LibraryEntry[];
}
