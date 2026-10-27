# Future ideas

> **Not committed scope.** These are ideas for after v0.1. Nothing here is planned or scheduled. Liam and the agent decide the next version together once v0.1 ships. Current direction is in [ROADMAP.md](../ROADMAP.md) and the v0.1 sequence is in [PLAN.md](PLAN.md).

## Integrated log management and analysis

This is Liam's proposal from October 26, 2026, kept as written with light restructuring.

### Vision

Integrate [RioLogManager](https://github.com/Ihlathi/RioLogManager)-style functionality into TerraScope as native, platform-agnostic log management and analysis. Support FRC robots, Terra, and other robotics projects. Keep log browsing, visualization, and diagnostics in one workspace.

### 1. Log library

- **Universal log management:** import, browse, organize, archive, and delete recordings.
- **Smart metadata:** automatically identify robot, event, match, session, autonomous routine, and software version when available.
- **Automatic naming and tagging:** descriptive labels, customizable templates, and manual overrides.
- **Advanced search:** filter by metadata, tags, telemetry characteristics, or detected anomalies.
- **Multi-robot support:** distinct libraries for different robots, teams, and projects.

### 2. Robot connectivity

- **Background sync:** discover configured robots and download new recordings automatically.
- **Connection plugins:** roboRIO over SSH/SFTP, Orange Pi over SSH, local storage, and future protocols.
- **Live recording:** capture telemetry directly within TerraScope.
- **Session detection:** identify autonomous runs, enabled periods, tests, and competition matches.

### 3. Intelligent analysis

- **Automatic anomaly detection:** electrical faults, communication problems, sensor failures, unexpected motion, and other unusual behavior.
- **Custom detection rules:** user-defined thresholds, conditions, and event patterns.
- **Automatic run reports:** summarize performance and important faults.
- **Regression detection:** flag degraded performance between runs and software versions.
- **Similarity search:** find comparable runs and outliers.
- **Performance trends:** chart reliability, speed, accuracy, and other metrics over time.

### 4. Visualization and replay

- **Instant log switching:** keep graphs and layouts while loading a different recording.
- **Side-by-side synchronized replay:** compare two runs at once.
- **Trajectory overlays:** compare paths and behavior in 2D and 3D.
- **Reference-run comparisons:** benchmark new tests against a known-good run.
- **Timeline annotations:** auto-mark anomalies and add manual bookmarks or notes.
- **Synchronized video:** align camera or match footage with telemetry.
- **Live-to-replay transition:** inspect a finished live run in the same workspace.

### 5. Developer tools

- **Git integration:** associate recordings with commits, branches, and builds.
- **Log comparison:** detect significant telemetry differences between software versions.
- **Exportable analysis:** share logs, reports, annotations, and visualization layouts.
- **Batch analysis:** process many recordings automatically.
- **Analysis plugins:** add custom metrics, parsers, detectors, and processing pipelines.

### 6. Workspaces

- **Persistent workspaces** per robot or project, for example "Terra — Swerve Development".
- **Saved state:** robot connections, log locations, visualization layouts, analysis rules, reference runs, and Git repositories.
- **Unified workflow:** live telemetry, log library, replay, comparisons, and diagnostics in one interface.
- **Integrated log sidebar:** switch recordings without rebuilding a visualization layout.

### Engineering considerations

- Keep core log management format-agnostic, with adapters for WPILOG and other formats.
- Split connection and sync, indexing and metadata, analysis, and visualization into modular services.
- Use safe sync: temporary downloads, verification, duplicate detection, and optional remote cleanup.
- Index metadata locally for fast search, for example with SQLite.
- Reuse the existing visualization instead of recreating graphs.
- Decide whether log management is core functionality with optional platform-specific plugins.

### Proposed order

1. Log library, metadata index, and reliable import and sync.
2. Seamless log switching and persistent visualization workspaces.
3. Session detection, annotations, and initial anomaly rules.
4. Synchronized run comparison, overlays, and reference runs.
5. Reports, regression detection, Git linking, and extensible plugins.

## Liam's follow-up priorities

Added the same day, after a first review:

- Upstream AdvantageScope's SFTP downloading is poor and its multi-log features are minimal. Both need real work, not reuse.
- Top interests:
  - Tracking the code version a log came from. This may depend on a TerraScope logging library built later.
  - Comparing runs and seeing what changed.
  - Anomaly detection, rule-based first, with a possible ML-based option later.
- Optimize the app at some point. AdvantageScope is slow and bloated at times.
- Rebranding is under consideration, toward a more personal, general-use project.

## Review notes

From the agent's first pass over the proposal:

- Treat the library, the metadata index, and log switching as the foundation. The rest builds on them.
- AdvantageKit logs already carry the git SHA, build date, and event metadata, so version tracking on FRC logs is cheap before a custom logging library exists.
- Start anomaly detection with built-in FRC rules (brownouts, CAN utilization, loop overruns, comms drops) plus user thresholds. Non-FRC robots need a defined schema before there is anything to detect.
- Don't design a general plugin API before two concrete adapters exist, such as roboRIO and Orange Pi. Extract the interface from what they share.
- Defer similarity search, regression detection, and trends until many runs are indexed with consistent metrics.
- A native SQLite module complicates the Electron build and CI. Try a JSON or WASM index first and switch only if search gets slow.
- Background sync only runs while the app is open, unless a separate helper process is built.

Suggested order:

1. Library over a local folder, with the metadata index and tags.
2. Log switching without rebuilding the layout, plus per-robot workspaces.
3. Rewritten sync with download verification and duplicate detection.
4. Session detection, annotations, and the first anomaly rules.
5. Run comparison and reference runs.
6. Reports, regression detection, the ML option, and performance work.

## Prior work: RioLogManager

[Ihlathi/RioLogManager](https://github.com/Ihlathi/RioLogManager) is a Python and PyQt6 desktop app for FRC teams. It syncs logs from a roboRIO over SFTP (paramiko), shows roboRIO disk usage and connection status, lists and deletes logs both locally and on the robot, and opens local logs in AdvantageScope.

Its sync writes each file straight to its final local path and, with auto-cleanup on, deletes the remote copy right after the download, with no size or checksum check. A TerraScope port should keep the workflow and add the safe-sync steps above: download to a temporary file, verify, dedupe, then clean up the remote.
