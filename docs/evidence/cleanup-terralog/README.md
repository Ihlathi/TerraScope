# TerraLog example cleanup

The production registry registered the TerraLog API example alongside supported readers. The production build also discovered example workers independently. This cleanup removes both links. The example stays in `src/examples/`, and the fixture test registers it explicitly before decoding its numeric samples.

The registry regression fails before the fix with `example-terralog` returned instead of `undefined`. [Failing output](regression-before.txt) records the Node 22 run. The passing registry test asserts the exact [dialog filter list](dialog-filters.json), rejects the example id, name, extension, and path, and verifies explicit registration in a separate registry. The existing fixture test compiles and executes the example worker.

## Screenshots

Electron ran under Xvfb on display `:99` at 1600 by 1000 pixels with isolated configuration, data, and cache directories. The existing `scripts/verify-reader-plugins.cjs --dialog` invoked the real File menu command and recorded the arguments passed to `electron.dialog.showOpenDialog`.

`Page.captureScreenshot` captured the Electron hub but omitted the native GTK dialog. There is no supported-import-format list inside the hub. The native dialog screenshots therefore use `DISPLAY=:99 import -window root`. The filter menu is open with its last entry selected so every format is visible. The before image includes TerraLog. The after image ends at NI Driver Station.

- [Before native filter menu](before-native-filters.png).
- [After native filter menu](after-native-filters.png).
- [Electron hub captured through CDP](after-hub-cdp.png).

The committed JSON contains the actual native dialog arguments after the fix, compared with the production registry. This is the same filter list asserted by the regression test.

## Verification

[Done-check output](done-check.txt) contains fresh Node 22 command output and exit codes for compile, tests, and formatting from the corrected evidence tree. The initial dependency setup needed a writable Electron cache and the session HTTP proxy for older download clients. These are environment settings only.

The production registry is shared by desktop, drag-drop, worker dispatch, and Lite. The clean desktop bundles and desktop/Lite build inputs were checked for example workers and references. The sample worker exists only in the test output.

Skipped outside Cursor. The control-ui integration is unavailable here. Electron CDP and Xvfb supplied the runtime verification.

To repeat the dialog check after compiling, start Xvfb and Electron, then invoke the existing verifier.

```bash
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 XDG_CONFIG_HOME=/tmp/ts/config XDG_DATA_HOME=/tmp/ts/data XDG_CACHE_HOME=/tmp/ts/cache npm start -- --no-sandbox --disable-gpu --remote-debugging-port=9222 --inspect=9230
READER_OUTPUT=docs/evidence/cleanup-terralog node scripts/verify-reader-plugins.cjs --dialog
```

The native menu screenshots used XTest input to open the format selector and select its last entry, followed by `DISPLAY=:99 import -window root`. The hub screenshot used the `connectDebugger` helper from `scripts/verify-multiple-live-sources.cjs` and `Page.captureScreenshot` with PNG output.

## Principle choices

Fix Root Causes put the change at production registration and build discovery. Laziness Protocol kept the existing registry and fixture harness without a flag or shim. Model the Domain kept reader metadata in that registry. Test Behavior, Not Implementation drove assertions on reader lookup, dialog filters, and decoded samples. Prove It Works required the running app and the clean bundle inspection.
