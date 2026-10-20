# Plan

This splits [ROADMAP.md](ROADMAP.md) into pull requests against `Ihlathi/TerraScope`. The roadmap is direction. A chunk can shrink or merge if the code argues for it, but it should stay one focused change that leaves current logs, live sources, and tabs working.

The order favors the seams in [ARCHITECTURE.md](ARCHITECTURE.md): a shared semantic layer, readers for formats people already have, live sources that are not FRC-specific, and removal of fixed field dimensions. Later chunks are still one PR each. They are not started here.

## 1. Identity, audit, and architecture

**Status: in progress (this PR).**

- Add `ROADMAP.md`, checked against the current AdvantageScope code.
- Present the fork as TerraScope in the README, window title, product name, and about text, without renaming protocols, the npm package, or log formats.
- Keep the BSD license, copyright notices, and attribution. Record the fork in `NOTICE`.
- Add this plan and `docs/ARCHITECTURE.md`.

No log or rendering behavior changes.

## 2. Semantic types on top of the log

Add a small semantic layer between `src/shared/log` and the tab controllers. Types to name first: pose 2d/3d, translation, rotation, trajectory, mechanism joint, and a plain numeric series. Map today's WPILib and AdvantageKit structs onto those types in one module the field, mechanism, and swerve controllers can call.

Do not add a format in this PR. The proof is that existing pose and mechanism views still render from the mapping, with tests around the mapping function.

## 3. Arbitrary 2D and 3D environments

Stop requiring an FRC or FTC field asset for a spatial view. Allow a user-set width, length, and origin, plus an optional image or glTF model. Keep bundled fields working. `RobotState.ts` mode colors can stay on the timeline; they should not define the scene size.

## 4. MCAP import

`@mcap/core` is already used to export scalars from `src/hub/exportWorker.ts`. Add a historical reader that opens `.mcap` into the same `Log`, including the channels and schemas the file declares. Leave Hoot-to-WPILOG conversion as it is. Cover a small fixture in a test. Foxglove-specific scene schemas wait for the semantic layer to grow.

## 5. JSON, JSONL, and TSV readers

CSV import already exists and only splits on commas (`CSVDecoder.ts`). Add TSV as a delimiter option, and add JSON/JSONL readers that turn an array of timestamped objects into log fields. Reuse `Log.putJSON` rather than a second object model.

## 6. Foxglove WebSocket live source

Add one `LiveDataSource` for the Foxglove WebSocket protocol: connect, advertise channels, subscribe, and append samples to the log. Manual address only. No second live connection in this PR. Decoding should land in the serialization seam, not in a renderer.

## 7. One live transport that does not decode

**Status: done.**

`LiveFrameTransport` separates socket lifecycle and framed messages from telemetry decoding. `RlogTcpTransport` strips RLOG TCP length prefixes in the main process, and `WebSocketFrameTransport` delivers Foxglove text and binary messages in the renderer. `RLOGDecoder` and `FoxgloveSession` still interpret the payloads. NetworkTables behavior is unchanged.

## 8. ROS 2 bag reader

**Status: done.**

Open a single ROS 2 sqlite3 `.db3` file into the existing log. The bag reader and MCAP reader share ROS 2 CDR decoding. Embedded `ros2msg` definitions take precedence over bundled common ROS 2 Humble definitions. Unknown types and encodings remain raw. Split bags, compressed bags, directory metadata, protobuf decoding, and ROS 1 bags are outside this chunk.

## 9. More than one clock

Let a sample carry a timestamp domain (receive time, log time, or an explicit clock id) without collapsing everything onto one number before it hits the log. The timeline keeps a single display clock and shows which domain it is using. NetworkTables latency adjustment should become an explicit conversion, not a hidden rewrite.

## 10. More than one live source

Remove the single-`liveSource` assumption in `hub.ts` enough to attach two sources at once, namespaced so topics do not collide. Start with two NetworkTables connections or NetworkTables plus the Foxglove source. Shared timeline, no fleet UI yet.

## 11. Generic numeric and enum lanes

Teach the line graph to treat enumerated values as a first-class discrete lane, and accept a user-declared unit when metadata has none. This is the rest of "graph it immediately" for non-WPILib logs. No expression language in this PR.

## 12. Point cloud and laser scan views

Add semantic types for a 2D laser scan and a 3D point cloud, fed by the MCAP/ROS reader, and one renderer that draws them in the existing 3D scene. Downsampling can be crude. No accumulation or LOD yet.

## 13. Image frames

Add an image sample type and a tab or 3D overlay that shows the frame nearest the timeline cursor. Camera calibration and detection boxes are separate PRs.

## 14. Transform tree

A frame graph (parent, child, static or dynamic transform) queried by the 3D scene, replacing one-off pose math where a log actually publishes frames. Missing parents are visible. Do not invent frames for old WPILib logs that do not have them.

## 15. URDF mechanism

Load a URDF (visual meshes and revolute/prismatic joints) and drive it from joint-state samples. Mechanism2d stays. SDF is later.

## 16. Continuous recording

Record the live log to disk (WPILOG first, MCAP as a follow-up PR) with start/stop and a disk-space check. The in-memory discard window remains the default so today's live view does not change until the user records.

## 17. Headless record

A small Node or CLI entry that uses the same live source and writer as chunk 16, with no Electron window. Status on stdout.

## 18. Plugin loader for readers

Turn `HistoricalDataSource.WORKER_NAMES` and `CustomSchemas` into a declared registration API, still in-process, with one example reader that is not compiled into the core switch. No marketplace and no remote code.

## Later chunks

Each of these is still one PR, after the foundations above. Order can change.

- ROS 1 bag reader.
- MQTT live source.
- DDS/ROS 2 live source, after the transport split.
- Generic TCP and serial adapters that sit on the transport interface.
- User-supplied protobuf or JSON schema when the file does not embed one.
- Derived signals: arithmetic between two fields, then a saved expression. The visual editor is its own PR after the evaluator exists.
- Bookmarks and user timeline notes stored beside the log, not inside it.
- Run comparison that aligns on a chosen event or pose instead of the first enabled timestamp.
- Covariance and particle views on the semantic pose type.
- Occupancy grid and costmap renderers.
- Detection boxes and segmentation overlays on the image view.
- Camera calibration display.
- Command and parameter audit log for NT4 and Foxglove writes.
- Multi-robot namespace in the sidebar once chunk 10 has landed.
- Python reader API over the log model, after semantic types are stable. C++, Rust, and Java bindings are separate PRs and should speak an existing protocol rather than a private one.
- Headless batch statistics over a directory of logs.
- Documentation pass that explains MCAP, Foxglove, and CSV without FRC terms. The current docs stay available for WPILib users.
- Automated tests around every new reader. The repository has no unit suite today; the first reader PR (chunk 4) is what introduces one.

Chunks that the roadmap lists and this plan does not schedule (fleet ops, Gazebo/MuJoCo/Isaac adapters, CI regression product, collaboration server, security review of third-party plugins) wait until a real user is blocked on them.
