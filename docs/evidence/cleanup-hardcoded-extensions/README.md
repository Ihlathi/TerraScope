# Registry-based file handling evidence

Reader preparation now selects both Driver Station paths for opening and deletion. The shared helper returns DS log bytes before event bytes, preserves the selected filename, and resolves companion extension case on Linux. CSV format help uses the CSV and TSV reader ids. The renderer forwards the selected events path unchanged.

## Reproduce

Use Node 22. Run `npm ci`, `npm run wasm:compile` with Emscripten 4.0.12, and `npm run compile`. Start Xvfb and Electron.

```sh
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 XDG_CONFIG_HOME=/tmp/ts/config XDG_DATA_HOME=/tmp/ts/data XDG_CACHE_HOME=/tmp/ts/cache npm start -- --no-sandbox --disable-gpu --remote-debugging-port=9222
```

Run the checks after the hub loads.

```sh
node docs/evidence/cleanup-hardcoded-extensions/verify-extensions.cjs
EXTENSION_MODE=events node docs/evidence/cleanup-hardcoded-extensions/verify-extensions.cjs
EXTENSION_MODE=csv node docs/evidence/cleanup-hardcoded-extensions/verify-extensions.cjs
DISPLAY=:99 import -window root docs/evidence/cleanup-hardcoded-extensions/malformed-CSV-dialog.png
```

The script generates version 4 `MATCH.practice.DSLOG` and `MATCH.practice.DsEvEnTs` files under `build/extension-fixtures`. It opens each through the app and asserts battery values of 12 and 12.5 volts and the companion event text. The table captures show those decoded values. CSV mode opens a malformed `.CSV`, asserts the format-help message, and forwards it to the native dialog. The desktop capture includes that dialog. CDP captures only the app.

`EXTENSION_BASELINE=1 EXTENSION_OUTPUT=/tmp/extension-baseline` records the old behavior for DS and CSV modes. Before the fix, the DS import omitted its event and the CSV error said "Please try again." The focused tests initially reported 17 passes and 14 failures. The additional renderer forwarding regression failed with `match.dslog` instead of `match.dsevents` before removing the rewrite.

## Verification

[Command output](checks.txt) records the done-check, regression tests, and app checks. Both new test files are registered in the test TypeScript configuration and npm script. The helper stays in `main.ts` and is present in the compiled main bundle. No new production module or build configuration is needed.

The install used `CI=true`, Node's `--use-env-proxy`, `ELECTRON_GET_USE_PROXY=1`, and the existing `global-agent` bootstrap with the inherited proxy. `YOUTUBE_DL_SKIP_DOWNLOAD=true` matches CI. These settings affect only the verification environment.

Skipped outside Cursor: control-ui. The running Electron app and CDP provide runtime verification. Origin was unavailable, so the GitHub connector creates the PR.
