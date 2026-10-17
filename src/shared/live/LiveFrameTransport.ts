// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** A socket that delivers framed payloads. Decoding stays with the caller. */
export interface LiveFrameTransport {
  start(onFrame: (frame: Uint8Array) => boolean, onClose: () => void): void;
  stop(): void;
}
