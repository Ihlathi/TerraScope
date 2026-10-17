// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/** Pulls complete big-endian int32 length-prefixed payloads out of a byte stream. */
export function readLengthPrefixedFrames(buffer: Uint8Array): { frames: Uint8Array[]; rest: Uint8Array } {
  const frames: Uint8Array[] = [];
  let rest = buffer;
  while (true) {
    if (rest.length < 4) break;
    const expectedLength = new DataView(rest.buffer, rest.byteOffset, rest.byteLength).getInt32(0) + 4;
    if (rest.length < expectedLength) break;
    const frame = rest.slice(4, expectedLength);
    rest = rest.slice(expectedLength);
    if (frame.length > 0) frames.push(frame);
  }
  return { frames, rest };
}
