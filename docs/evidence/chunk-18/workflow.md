# Reader registration migration

- Read the Principles section of the poteto-mode skill.
- Phase A: Frame
- Phase B: Design the workflow
- Phase C: Run the loop
- Capture fixture field lists before the migration.
- Register existing readers and schemas, then migrate all consumers and delete old tables.
- Run registry and fixture checks, compile, full tests, and formatting.
- Launch Electron and capture the filters, WPILOG, and MCAP fixtures.
- Phase D: Keep the audit trail
- Phase E: Verify and hand back
- Open one PR against Ihlathi/TerraScope main, then stop.

The completion predicate is passing compile, tests, and formatting with unchanged fixture fields, startup duplicate-extension rejection naming both readers, and screenshots from the running app. Dependency installation and the WASM build are additional repository gates.

The chosen design retains worker messages and decoding implementations. A generic worker factory was considered but would require changing lazy WPILOG state and sqlite initialization. Typed declarations provide the requested registration with less decoding risk. Worker source discovery uses the existing Worker.ts naming convention so adding a reader does not require another build table.

The migration covers 14 existing file extensions, 10 worker entry points, and three custom schema decoders. Implementation work runs across separate file ownership. The next checkpoint is a compiled registry and fixture comparison before the full app check.

Skipped outside Cursor: deslop, Bugbot, and control-ui. They are unavailable here. Independent review and Electron verification replace those steps.
