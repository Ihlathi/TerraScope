# Architecture

TerraScope currently runs the AdvantageScope application. This note maps that pipeline and names the seams where a new format or protocol can plug in without a redesign of the views. It also states the layering from roadmap section 42: ingestion, transport, serialization, semantics, and rendering stay independent of each other. The code only partly does that today. The gaps are called out below.

## Pipeline

```text
file or socket
    │
    ▼
ingestion (main process + worker, or a live source)
    │  bytes in, Log samples out
    ▼
log model (src/shared/log)
    │  named, timestamped, typed fields
    ▼
semantic read (tab controllers, RobotState, geometry helpers)
    │  poses, mechanisms, console lines, graph series
    ▼
rendering (src/shared/renderers)
```

Live and recorded data meet at the same `Log`. Tabs do not know whether a sample came from a file or a socket. That is the strongest seam in the current code.

## Ingestion

Ingestion turns an outside source into `Log` samples. It is split by lifetime.

### Recorded files

`src/hub/dataSources/HistoricalDataSource.ts` picks a worker from the file extension (`WORKER_NAMES`). The Electron side reads the whole file in `src/main/electron/main.ts` (`historical-start`) and may convert it before the worker runs.

| Extension              | Where it is decoded                                                                    | Notes                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `.wpilog`              | `src/hub/dataSources/wpilog/wpilogWorker.ts`, `WPILOGDecoder.ts`, WASM `wpilogIndexer` | Indexed. Field bodies load on request (`parseField`).                 |
| `.wpilogxz`            | Main process LZMA, then the WPILOG worker                                              |                                                                       |
| `.hoot`                | `owletInterface.ts` converts to WPILOG after a CTRE license check                      | Not generic MCAP.                                                     |
| `.revlog`              | `@rev-robotics/revlog-converter` to WPILOG                                             |                                                                       |
| `.rlog`                | `src/hub/dataSources/rlog/rlogWorker.ts`, `RLOGDecoder.ts`                             | Revisions 1 and 2. Full decode.                                       |
| `.log`                 | `src/hub/dataSources/roadrunnerlog/`                                                   | Road Runner magic `RR`, revisions 0 and 1.                            |
| `.csv`                 | `src/hub/dataSources/csv/CSVDecoder.ts`                                                | Commas only.                                                          |
| `.dslog` / `.dsevents` | `src/hub/dataSources/dslog/`                                                           | Paired files. Also detected when a WPILOG wrapper says `DS Log File`. |

Open-dialog filters live next to `historical-start` in `src/main/electron/main.ts`. AdvantageScope Lite (`src/main/lite/main.ts`) fetches bytes over HTTP and rejects `.hoot` and `.revlog`.

There is no streaming read from disk. The process holds the file bytes, then the worker fills a `Log`.

### Live connections

`src/hub/hub.ts` manages a live session. The existing Connect commands replace the session and retain single-source field paths. Add Live Source attaches another connection and groups fields under stable `/LiveN` namespaces. Connecting stops historical playback. Implementations:

| Mode                                                | Class                                                    | Transport                                                |
| --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `nt4`, `nt4-akit`, `nt4-systemcore`, Driver Station | `src/hub/dataSources/nt4/NT4Source.ts`, `NT4.ts`         | WebSocket after an HTTP port probe (5810, 6767, or 6810) |
| `rlog`                                              | `src/hub/dataSources/rlog/RLOGServerSource.ts`           | `RlogTcpTransport` in the Electron main process          |
| `phoenix`                                           | `src/hub/dataSources/PhoenixDiagnosticsSource.ts`        | HTTP JSON on port 1250                                   |
| `ftcdashboard`                                      | `src/hub/dataSources/ftcdashboard/FTCDashboardSource.ts` | WebSocket on port 8000                                   |
| `foxglove`                                          | `src/hub/dataSources/foxglove/FoxgloveSource.ts`         | `WebSocketFrameTransport`, default port 8765             |

`src/shared/live/LiveFrameTransport.ts` defines the socket lifecycle and frame delivery contract. RLOG TCP strips its big-endian length prefix before sending payload bytes over IPC. WebSocket messages keep their text or binary form. The transports do not import `Log` or decode telemetry. `RLOGServerSource` and `FoxgloveSource` retain reconnect policy and pass frames to `RLOGDecoder` and `FoxgloveSession` respectively.

`LiveDataSource.ts` can drop samples older than the live discard window. Writes are separate: `NT4Tuner.ts`, `NT4Publisher.ts`, and the FTC config path that implements `LiveDataTuner.ts`. Lite allows only the NetworkTables and FTC modes (`LITE_ALLOWED_LIVE_MODES` in `src/shared/Preferences.ts`).

Each connection owns its decoded log and schema state. A multi-source session projects those fields into one display log without copying accumulated samples on each update. Explicit clock offsets map independent source clocks to a shared receive-time timeline. The alignment is receive-estimated, and original source timestamps remain available. Source-local discard, subscription routing, and reconnect replacement keep one connection from changing another's samples.

`src/hub/SourceList.ts` is not ingestion. It binds log keys to whatever the active tab is showing.

## Log model

`src/shared/log/Log.ts` and `LogField.ts` are the in-memory recording. `LoggableType.ts` is the closed set of sample types: raw, boolean, number, string, the three array forms, and an empty placeholder for structured children.

Keys are hierarchical strings. Timestamps are seconds. Each field can carry a WPILib type string, a structured type, and a metadata string. Units are parsed from that metadata in `Log.ts`. `Log.toSerialized` / `fromSerialized` move a log across the worker boundary, including queued struct and protobuf schemas.

`LogTimestamp` accepts numeric seconds or a timestamp tagged as log time, receive time, or a named clock. Each `Log` declares one display clock. A timestamp from another domain requires an explicit source-to-display conversion. Fields retain the original tagged timestamp alongside the numeric display index, including through worker serialization, trimming, and merge alignment. `getTimestampSources` reads those originals. Legacy numeric writes retain their existing coordinates and use the display domain as a fallback.

The shared playback controls show the active display clock. NetworkTables samples use its server clock. Its live cursor uses an explicit receive-to-server conversion that applies the measured offset and latency. This conversion preserves the existing cursor calculation and does not subtract latency from stored samples.

Several files can be opened together. `hub.ts` merges them with `Log.mergeWith`, prefixing keys `/LogN` (`LogKeyUtils.ts`) and aligning on the first enabled timestamp.

This model is the common representation the roadmap asks for, with a narrow type system and a single timeline.

## Serialization

Serialization is "bytes or a host value become `Log` samples." It is not a separate layer. Each ingestion path decodes as it inserts.

Shared decoders:

- `src/shared/log/StructDecoder.ts` — WPILib struct schemas
- `src/shared/log/PhotonStructDecoder.ts` — PhotonVision structs
- `src/shared/log/ProtoDecoder.ts` — protobuf descriptors
- `Log.putJSON`, `putMsgpack`, `putRaw`, `putStruct`, `putProto` — the insert API
- `src/hub/dataSources/schema/CustomSchemas.ts` — hand-written binary layouts (URCL and Spark CAN frames under `schema/spark/`)

Schema topics match `/.schema/` (`LogKeyUtils.ts`). WPILOG and NetworkTables recognize `struct:`, `photonstruct:`, `proto:`, `msgpack`, `json`, and names registered in `CustomSchemas`.

Export is the write side, and it is separate from ingestion: `src/export.ts` collects options, `src/hub/exportWorker.ts` emits CSV (table or list), WPILOG (`WPILOGEncoder.ts`), or MCAP (`@mcap/core`). MCAP export covers scalar types and skips raw samples. Nothing in the open path reads MCAP.

## Semantics

Semantics are "this field is a pose, a mechanism, a joystick, a console line." There is no shared semantic registry. Each tab controller recognizes the types it knows.

- Poses, trajectories, AprilTags, and heatmaps: `src/hub/controllers/Field2dController.ts`, `Field3dController.ts`, helpers in `src/shared/geometry.ts`
- Mechanisms: `MechanismController.ts`, `src/shared/log/LogMechanismState.ts`
- Swerve: `SwerveController.ts`
- Joysticks: `JoysticksController.ts`, `LogJoystickState.ts`
- Console text: `ConsoleController.ts`
- Enabled, auto, and alliance ranges: `src/shared/log/RobotState.ts` (fixed key lists)
- Units: `src/shared/units.ts`, applied from the line-graph controller

`geometry.ts` stores `Rotation3d` as a quaternion `(w, x, y, z)` and can show roll, pitch, and yaw. Coordinate conversion is a single preference over built-in FRC and FTC conventions (`AdvantageScopeAssets.ts`), not a transform tree and not an arbitrary frame.

Field size comes from the asset (`topLeft` / `bottomRight`), not from the log. A new environment means a new asset, not a generic scene with free dimensions.

## Rendering

`src/shared/TabType.ts` lists the tabs. `src/hub/Tabs.ts` constructs a controller and a renderer per tab. Renderers under `src/shared/renderers/` draw canvases, DOM, Chart.js, or three.js. They receive prepared commands from controllers. They do not open files or sockets.

The timeline (`src/hub/Timeline.ts`, `SelectionImpl.ts`) is shared. Playback speed, looping the visible range, and seeking are selection state, so every tab follows one cursor. Video (`VideoRenderer.ts`) locks to that cursor but loads a separate media file.

3D rendering is WebGL in `Field3dRendererImpl.ts`, with glTF/GLB loading in `field3d/workers/loadRobot.ts` and `loadField.ts`. AdvantageScope XR (`src/main/electron/XRServer.ts`, `src/xrClient/`) streams that 3D scene to the iOS companion. It is another renderer, not another data model.

## Where the five layers leak

Roadmap section 42 asks for independent layers. Today:

| Layer         | What is independent                                                                                        | What is still coupled                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Ingestion     | Workers and live sources only have to produce a `Log`. Live connections retain independent decoding state. | File detection, conversion, and dialogs sit in `main.ts`.                                                           |
| Transport     | RLOG TCP and Foxglove WebSocket adapters deliver frames without decoding telemetry.                        | NetworkTables still combines WebSocket transport and protocol interpretation.                                       |
| Serialization | Struct, protobuf, and custom schema decoders are callable from more than one source.                       | WPILOG record layout, RLOG framing, and CSV parsing are private to those readers. MCAP can be written and not read. |
| Semantics     | Tabs agree on `LoggableType` and WPILib type strings.                                                      | Pose, mechanism, and swerve meaning is reimplemented per controller. `RobotState.ts` hard-codes FRC keys.           |
| Rendering     | Renderers do not import data sources.                                                                      | A new visual meaning still needs a controller change. There is no semantic object a new renderer can subscribe to.  |

## Seams for a new format or protocol

A new recording format, without new visualizations:

1. If the bytes are not already a supported encoding, convert or index them beside the existing branches in `historical-start` (`src/main/electron/main.ts`).
2. Add the extension to `HistoricalDataSource.WORKER_NAMES` and to the open-dialog filters.
3. Write a worker that posts `HistoricalDataSource_WorkerResponse` (`initial`, and `parseField` if loading should stay lazy). `wpilogWorker.ts` is the lazy pattern. `csvWorker.ts` is the full-decode pattern.
4. Insert samples only through `Log.put*`. If the payload is a struct or protobuf, reuse `StructDecoder` or `ProtoDecoder` instead of inventing fields by hand.
5. Nested recordings use the `log:EXT` structured type (`LogKeyUtils.getChildLogExtension`) so `HistoricalDataSource.openRaw` can open them.

A new live protocol:

1. Subclass `LiveDataSource` and implement `connect` / `stop`. Use `handleMainMessage` if the socket has to live in Electron (the RLOG pattern). Lite cannot host raw TCP.
2. Add a `LiveMode` in `src/shared/Preferences.ts`, including `getLiveModeName` and the Lite allow-list if the browser can speak it.
3. Construct it from the `startLive()` switch in `src/hub/hub.ts`.
4. Optional writes implement `LiveDataTuner`.

A new serialization, on a format that already exists:

- Register a binary layout in `CustomSchemas.set`, or teach the struct/protobuf path about the schema. Do this before adding a tab.

A new semantic type that existing views should understand:

- Prefer a mapping onto pose, trajectory, mechanism, or numeric fields at the controller boundary (`Field3dController.ts` and `geometry.ts` are the pose seam). A later semantic layer should sit between `Log` and those controllers so WPILib structs, ROS messages, and Foxglove schemas can name the same pose.

A new visualization:

- Add a `TabType`, a controller, and a renderer, and wire them in `Tabs.ts`. Do not import a data source from the renderer. If the view only needs numbers, strings, or poses that are already in the log, no ingestion change is required.

## What not to couple further

New work should not teach a renderer about MCAP channels, NetworkTables topic types, or FRC field dimensions. Those facts belong in ingestion, serialization, or an asset, and should arrive at the renderer as log fields or a scene description. `RobotState.ts` and fixed field assets are assumptions roadmap section 42 calls out. They stay in place until a change is aimed at them. See [PLAN.md](PLAN.md).
