# URDF verification

The 3D tab loads one user-selected URDF or a logged `robot_description` and positions its links from JointState samples at the timeline cursor. Boxes, cylinders, spheres, local STL meshes, and local DAE meshes render through the shared frame graph. Logged TF owns overlapping child frames.

Revolute and prismatic joints clamp to their limits. Continuous joints rotate without limits. Mimic joints apply `multiplier * position + offset`, including chains. Planar and floating joints stay fixed with visible diagnostics. Unsupported visuals are skipped with diagnostics. Named materials share renderer resources across links. COLLADA Y_UP meshes rotate 90 degrees about X into Z-up. Z_UP retains its authored axes. X_UP produces a visible unsupported-axis diagnostic. SDF, collision geometry, interpolation, and velocity or effort visualization remain outside this change.

## Review fixes and proofs

| Finding                       | Behavior and regression proof                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout file access            | `URDFSources.test.ts` proves layout-supplied URLs cause no source read or registry write. Controller tests prove XML, URLs, and legacy directory fields are ignored. Only opaque references to previously picked sources restore. Robot files must be regular `.urdf` files no larger than 10 MiB. A FIFO is rejected without blocking. |
| Per-frame robot serialization | `URDFTransport.test.ts` exercises the actual renderer change-detection method with a robot whose `toJSON` throws. Frame commands contain only model IDs and link poses. Resources are delivered on change and replayed to new clients. Satellite and XR tests prove deduplication and replay.                                           |
| Corrupt source registry       | `URDFSources.test.ts` covers invalid JSON, wrong root and entry shapes, all three picker kinds, own-property IDs, and prototype names. Invalid registry roots recover to an empty registry and do not block the picker. Invalid entries are dropped individually so valid saved sources survive the next pick.                          |
| Live discard and trimming     | `URDFLog.test.ts` checks 120 no-op discards, trim followed by append without a range from negative infinity, compressed partial joint histories, and projected live sources. Main's projected timestamp cache remains in place.                                                                                                         |
| Shared topic discovery        | The controller and its tests call the same `discoverURDFTopics` implementation. One key scan discovers both descriptions and JointState topics. None excludes their subscriptions.                                                                                                                                                      |
| Accurate PR evidence          | The PR description links this final evidence, embeds the screenshots, and includes real Node 22 output. Full output is in `checks.txt`.                                                                                                                                                                                                 |
| Model-format scope            | `ROADMAP.md` leaves common model-format support unchecked. glTF/GLB assets and STL/DAE URDF visuals are supported. OBJ is not supported.                                                                                                                                                                                                |
| JointState alerts             | `URDFLog.test.ts` proves future errors are excluded and repeated past errors are capped and summarized. Diagnostics use a binary search at the cursor.                                                                                                                                                                                  |
| Closed-tab listeners          | `Field3dController.test.ts` proves disposal removes the picked-source listener before any later event. Disposal also stops the source list and releases the custom asset.                                                                                                                                                               |
| X_UP COLLADA                  | `URDFManager.test.ts` proves the unsupported X_UP mesh produces a diagnostic while the other visual remains rendered.                                                                                                                                                                                                                   |

Local source paths live in `userData/urdf-sources.json`. Layouts store opaque references, never the URDF XML or absolute source URLs. References persist across app restarts on the same computer. Sources must be picked again on another computer. The unshipped legacy XML and URL layout format is intentionally ignored.

Robot model resources travel separately from per-frame commands in the local renderer, satellites, and XR. Each receiver retains one current model. Satellite readiness, reload, and show events request the current resource. Renderer disposal releases its model and visual managers. The real main dispatcher is covered by `ImageSatelliteRouting.test.ts`, including optional resources, explicit clears, and resource replay.

## Rebase integration

Rebased onto main `c6b83582`. Main's history state supplies source identity, clock offset, rewrite revision, trim revision, retained count, and removed count. JointState caches use `getHistoryState()` and `getTimestamp()` directly. `LogField`, `Log`, and `ProjectedLogField` match main. `FrameGraph.trimBefore` and all of main's FrameGraph tests remain intact, with URDF supplemental edges layered onto lookup only. The duplicate branch mutation accessors and wrapper-reuse mechanism are removed.

The parser no longer creates a test-only robot ID. Renderer tests use the same resource ID generator as the controller. URDF edges use the shared `SupplementalFrameEdge` type. The mixed-registry regression proves that malformed entries do not remove valid robot and package references.

## Fixtures and replay

Run `python3 scripts/generate-urdf-fixture.py` to regenerate the robot, STL carriage, DAE tool, and ROS 2 bag under `src/hub/dataSources/ros2/fixtures/urdf/`. The generator uses the Python standard library. Its geometry uses the repository's BSD license.

Open `robot.db3`, select `/robot_description`, select the fixture directory with **Logged mesh directory**, and select its `packages` directory with **Package root**. Alternatively, pick `robot.urdf` directly. At cursor 1.5, the shoulder and slider are zero. At 2.5, they are 1 radian and 0.7 meters. The second sample reverses the joint-name order. At 3, samples exceed the limits. A static transform connects `map` to `base_link`.

## Real application verification

After compilation, launch the desktop app on a virtual display.

```bash
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 XDG_CONFIG_HOME=/tmp/ts/config XDG_DATA_HOME=/tmp/ts/data XDG_CACHE_HOME=/tmp/ts/cache npm start -- --no-sandbox --disable-gpu --remote-debugging-port=9222
node docs/evidence/chunk-15/verify-urdf.cjs urdf
node docs/evidence/chunk-15/verify-urdf-satellite.cjs
node docs/evidence/chunk-15/verify-urdf.cjs wpilib
```

The verifier opens the real ROS 2 bag reader and checks link poses at both cursor times and after rewind. It creates a tall Y_UP DAE and delivers its trusted generated bytes through the picked-source result event. The normal parser, model-resource path, and mesh loader render it. File-selection security is verified separately by the source-boundary tests. Screenshots use CDP `Page.captureScreenshot`. Temporary fixtures go under `build/urdf-visual-verification`.

The satellite verifier opens and reloads a real 3D satellite. It observes at least 30 frame messages and proves the robot resource arrives exactly once and the frame commands contain no robot model. Its screenshot is `urdf-satellite.png`.

The WPILib verifier generates a WPILOG with a typed Pose3d, opens it through the real reader, and renders the existing KitBot with URDF None. The retained main comparison in `wpilib-compatibility.json` records identical robot commands and zero changed pixels against main `74591d98`. This round also compares the recaptured canvas against the pre-fix canvas to verify the existing model is unchanged after these fixes.

![URDF at cursor 1.5](https://raw.githubusercontent.com/Ihlathi/TerraScope/a7e3470c650f952cbb1d2d82fb5a847dd073c8b1/docs/evidence/chunk-15/urdf-1.5.png)
![URDF at cursor 2.5](https://raw.githubusercontent.com/Ihlathi/TerraScope/a7e3470c650f952cbb1d2d82fb5a847dd073c8b1/docs/evidence/chunk-15/urdf-2.5.png)
![Y_UP DAE upright](https://raw.githubusercontent.com/Ihlathi/TerraScope/a7e3470c650f952cbb1d2d82fb5a847dd073c8b1/docs/evidence/chunk-15/dae-y-up-upright.png)
![Existing WPILib robot](https://raw.githubusercontent.com/Ihlathi/TerraScope/a7e3470c650f952cbb1d2d82fb5a847dd073c8b1/docs/evidence/chunk-15/wpilib-robot.png)

![URDF in a real satellite](https://raw.githubusercontent.com/Ihlathi/TerraScope/a7e3470c650f952cbb1d2d82fb5a847dd073c8b1/docs/evidence/chunk-15/urdf-satellite.png)

## Checks and workflow

`checks.txt` contains the actual Node 22 installation, Emscripten 4.0.12 build, compile, test, format, and CDP verification output. `app-launch.txt` records the real Electron launch. Xvfb was extracted locally after the system package install failed for lack of privileges.

The decision trail is in `decisions.tsv`. The figure-it-out workflow separates source security, controller lifecycle, incremental history, and model transport. Model the Domain led to explicit model-resource messages and source references. Fix Root Causes removed the unsafe migration and separated trimming from rewrites. Prove It Works led to source-boundary regressions, real-dispatcher tests, and actual Electron captures.

The vendored deslop skill ran on the diff against main before commit. It retained the comment explaining COLLADA axes and renamed the shared satellite refresh helper. Independent review checked security, cache behavior, resource lifetime, and transport forwarding. Skipped outside Cursor: control-ui is unavailable. The Electron verifier supplies runtime evidence. Origin is unavailable, so GitHub CLI updates the existing PR. No new PR is opened.
