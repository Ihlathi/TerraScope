// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

export interface LiveFrameTransport<Frame> {
  start(onFrame: (frame: Frame) => boolean, onClose: () => void): void;
  stop(): void;
  write(data: Frame): void;
}
