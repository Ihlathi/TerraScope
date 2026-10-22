# Add a log reader

Use the TerraLog example in `src/examples/` as the template for a reader compiled into TerraScope.
Its `.terralog` files contain one numeric sample per line, with tabs between the timestamp in seconds, field name, and value.

1. Copy `src/examples/terraLogReader.ts` and `src/examples/terraLogWorker.ts` into a reader directory under `src/hub/dataSources/` or `src/examples/`.
2. Give the registration a unique `id`, a `displayName`, and one or more `extensions` without leading dots.
3. Set `worker` to the compiled worker filename. Name its source file `*Worker.ts` so the build discovers it.
4. Replace the worker's parser with your decoder. Write samples through `Log.put*`.
5. Import your registration function in `src/shared/plugins/builtins.ts` and call it with `plugins`.
6. Run `npm run compile` and `npm start`. Open a file with your extension from **File > Open** or drag it into the app.

The open dialog, file acceptance, and worker dispatch use the registered extension.
Register each extension once. A collision throws during startup and names both reader ids.

The worker receives a `HistoricalDataSource_WorkerRequest` with `type: "start"` and the file bytes in `data[0]`.
Return an `initial` response containing `log.toSerialized()` and `isPartial: false`.
Return `failed` if the file cannot be decoded.
The existing WPILOG worker demonstrates lazy loading through `parseField` requests.

To try the example, save this content as `example.terralog`, with literal tabs between columns.

```text
0	/Example/Speed	1
1	/Example/Speed	2
2	/Example/Speed	3
```

After opening the file, `/Example/Speed` appears in the sidebar with three numeric samples.

## Add a schema decoder

Call `plugins.registerSchema` in `src/shared/plugins/builtins.ts` with an `id`, a `displayName`, and a `decode` function.
Use the schema type carried by the recording as the `id`.
The decoder receives a `Log`, a field key, a timestamp, and the raw `Uint8Array` sample.
Write decoded children through `Log.put*`.
Duplicate schema ids throw during startup.

Registrations are source imports reviewed and compiled with the application.
The app does not search disk for plugins or execute code from a recording.
