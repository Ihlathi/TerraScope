# Continuous WPILOG recording

The app records all attached live sources to WPILOG while its normal memory discard window remains active. The recording uses stable `/Live1` and `/Live2` prefixes and each sample's original numeric source timestamp. It retains repeated values and backdated arrivals before the display log compresses them.

The [recording controls](recording-controls.png) show both local NetworkTables sources during recording. The [reopened log](reopened-log.png) shows the actual file through the existing WPILOG reader with both voltage fields graphed. [UI observations](ui-verification.json) contain file sizes, sample counts, and exact fixture comparisons. [Command output](checks.txt) contains the dependency, WebAssembly, compile, test, formatting, and app checks.

The app check uses a one-second live discard window and records for four seconds. Each fixture publishes a voltage and an unselected hidden field. The check asserts that all four fields reach disk with the same timestamps and values sent by their source. The file grew from 1,488 to 5,313 bytes before Stop. It closed at 5,523 bytes and did not grow afterward. The recording contains 86 samples per field from the first source and 85 per field from the second source. The reopened graph contains exactly the recorded voltage samples. The captured [WPILOG file](two-sources.wpilog) is included.

All 105 tests passed, including 29 new recording tests. The [app launch output](app.txt) records the Electron run.

To repeat the check, compile the app and tests, then start Electron with its renderer and main inspectors enabled.

```bash
npm run compile
npm test
npm start -- --inspect=9230 --remote-debugging-port=9222
RECORDING_OUTPUT=build/recording-ui node scripts/verify-continuous-recording.cjs
```

The script starts its local fixtures on `127.0.0.1:5810` and `127.0.0.2:5810`. It replaces the native save dialog's result through the main inspector. The controls, IPC, disk writer, historical file open, and graph run through the app's production paths. Use a disposable app profile when repeating the check because the script changes the live connection preferences and tab layout.

The Node writer leaves a 64 MiB disk reserve and checks it before starting, before each batch, and once per second while idle. Tests inject free-space readings to check startup refusal without truncation and automatic stops during active and idle recording. The UI tests check that automatic stops detach capture and display the reason. The writer and IPC queues have fixed byte limits and stop with a visible message if storage cannot keep up.

This chunk does not implement the headless command, MCAP recording, rotation, compression, automatic triggers, or restoration of tagged clock domains. WPILOG stores source timestamps at microsecond resolution. Existing schemas are seeded when recording starts, but earlier display history is not copied into the recording.

Model the Domain shaped the typed sample union and recording lifecycle. Boundary Discipline kept file access in the Node writer and Electron adapter. Prove It Works required the actual file to reopen in the app.

Skipped outside Cursor: deslop, Bugbot, and control-ui. Those tools are unavailable. Independent code and comment review, behavior tests, and the Electron fixture check cover this change. GitHub CLI is the fallback forge because Origin is unavailable. The GitHub connector creates the pull request.
