# Unsupported file drop evidence

Dropping an unsupported file now uses the same native Electron error dialog as a reader failure. A mixed drop still opens its supported files and reports its rejected files.

## Reproduce

Use Node 22. Run `npm ci`, `npm run wasm:compile`, and `npm run compile`. Start Xvfb and the app.

```sh
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 XDG_CONFIG_HOME=/tmp/ts/config XDG_DATA_HOME=/tmp/ts/data XDG_CACHE_HOME=/tmp/ts/cache npm start -- --no-sandbox --disable-gpu --remote-debugging-port=9222
```

Run the check after the hub loads. Dismiss the native dialog before each subsequent run.

```sh
node docs/evidence/cleanup-dragdrop/verify-drop.cjs
DROP_MODE=supported node docs/evidence/cleanup-dragdrop/verify-drop.cjs
DROP_MODE=mixed node docs/evidence/cleanup-dragdrop/verify-drop.cjs
```

The script creates real fixture files under `build/drop-fixtures`, drops them with CDP `Input.dispatchDragEvent`, and verifies their paths through `window.electron.getFilePath`. It records and forwards the existing open and error messages. Supported and mixed runs also assert that the CSV values are `[42, 84]` in the app's log.

## Results

[Console output](checks.txt) records Node 22.23.4, the dependency install, WASM and bundle compilation, the full test suite, the format check, and the CDP runs. The new helper is imported by `hub.ts` and appears in `bundles/hub.js` after compilation.

The pre-fix CDP check resolved the dropped path correctly, then failed because it received `[]` instead of an error. The fixed check receives the existing error payload. Supported-only and mixed checks verify the parsed CSV values. The mixed fixture uses a separate field name so a previous supported-only run cannot satisfy its assertion.

The install used the inherited HTTP proxy, Node's `--use-env-proxy`, and the installed `global-agent` bootstrap for the legacy download helper. `YOUTUBE_DL_SKIP_DOWNLOAD=true` matches CI. No repository configuration changed for this environment setup.

## Captures

`Page.captureScreenshot` captures the app state in `unsupported-drop.png`, `supported-drop.png`, and `mixed-drop.png`. It does not capture the separate native dialog. `dialog-message.txt` contains the exact error title and content asserted by the unit tests and the CDP check.

The desktop captures `unsupported-dialog.png` and `mixed-dialog.png` include the native error dialog on Xvfb. These were captured with `DISPLAY=:99 import -window root <filename>` after the corresponding CDP run.

Skipped outside Cursor: control-ui. Electron and CDP provide the runtime verification here.
