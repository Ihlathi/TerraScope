# Reader registration verification

All 120 tests passed. The five registry tests cover extension lookup, duplicate-extension rejection naming both readers, atomic registration, filter contents, and the three existing custom schemas. Ten worker tests cover the eight preexisting recording fixtures, the fixture inventory, and numeric samples from the example reader.

The [field baseline](../../../scripts/reader-fixture-fields.json) was captured from the original worker implementations before migration. The test selects each worker through the registered extension, runs it, and compares the full field list. The WPILOG check also requests lazy fields. The fixtures include TSV, JSON, JSONL, MCAP, both ROS 2 sqlite3 bags, CSV, and WPILOG. Hoot and REV converters and RLOG, Road Runner, and DS workers retain their existing implementations and now use registered dispatch. No committed fixtures exist for those formats.

[Command output](checks.txt) records successful dependency installation, the Emscripten 4.0.12 WASM build, bundle compilation, tests, and formatting. Installation uses workspace caches because the default cache directories are read-only here. Node's environment proxy support is enabled for dependency downloads. Tests run with local network access for their fixture servers.

The Electron check launches the compiled application with a disposable profile. [UI observations](ui-verification.json) contain the actual field lists and numeric samples. The [WPILOG screenshot](wpilog.png) shows both recorded voltage signals. The [MCAP screenshot](mcap.png) shows the MCAP voltage field. The [native open-file dialog](open-file-filters.png) shows filters generated from the registry. [Captured filter arguments](dialog-filters.json) record the exact values passed to Electron's original dialog implementation.

To repeat the file-open screenshots, start Electron with renderer and main inspectors, then run the script.

```bash
npm start -- --inspect=9230 --remote-debugging-port=9222
node scripts/verify-reader-plugins.cjs
node scripts/verify-reader-plugins.cjs --dialog
```

The dialog mode opens the native dialog through the application menu. Capture the desktop with its filter dropdown open. The other mode opens both real fixtures through the app's historical-file path and captures the rendered graphs.

The [workflow](workflow.md) records the design and completion predicate. The [decision trail](decisions.tsv) records the migration checkpoints. Independent code and comment review found a nested-worker discovery issue, which is fixed. No findings remain. A session transcript was unavailable for a separate audit of the trail.

Skipped outside Cursor: deslop, Bugbot, and control-ui. These tools are unavailable. Independent review, worker tests, and the Electron check cover this change. Origin is unavailable, so GitHub CLI handles the push and status reads. The GitHub connector creates the PR. Runtime loading of external code is outside this change.
