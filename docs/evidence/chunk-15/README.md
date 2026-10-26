# URDF verification

Regenerate the fixture with `python3 scripts/generate-urdf-fixture.py`. The generator uses the Python standard library. It writes [robot.urdf](../../../src/hub/dataSources/ros2/fixtures/urdf/robot.urdf), an ASCII STL, a Collada DAE, and a ROS 2 sqlite3 bag with logged robot description and joint states. The geometry is authored for this fixture and uses the repository's BSD license.

The robot has a box base, a cylinder and sphere on the arm, an STL carriage, and a DAE tool. The shoulder rotates about Z with limits of -1.2 and 1.2 radians. The slider translates along X between 0 and 0.8 meters. A fixed joint connects the tool to the carriage.

At cursor 1.5, both movable joints are zero. At cursor 2.5, the shoulder is 1 radian and the slider is 0.7 meters. The second sample reverses the order of the joint names. At cursor 3, the shoulder sample exceeds its upper limit and the slider sample falls below its lower limit. A static logged transform connects `map` to `base_link`. The scan uses `tool_link` so it can follow the robot through the shared frame graph.

For file loading, select `robot.urdf`. Select the `packages` directory as the package root. The STL path is relative to the URDF. `package://demo/meshes/tool.dae` resolves under `packages/demo/meshes/tool.dae`.

For the logged description, open `robot.db3` and choose `/robot_description` in the URDF selector. Choose the `urdf` fixture directory with **Logged mesh directory** and its `packages` directory with **Package root**. The JointState selector can choose a typed topic explicitly or select the first topic in the description's namespace automatically. File-loaded robots use the selected JointState topic's namespace. An absent joint sample uses zero, clamped to the joint limits.

## Frame ownership

Both robot visuals and frame-bearing objects resolve through the chunk 14 frame graph at the timeline cursor. URDF joints add parent-child edges only when no logged TF track owns that child. Logged `/tf` or `/tf_static` wins for the child even before its first dynamic sample or when its transform is invalid. There is no fallback to a URDF joint on a temporarily unavailable logged edge. The same rule places the robot link and any object attached to it.

Static joints compose throughout the recording. Joint positions hold the latest value for each name at or before the cursor in the log's display clock. Partial JointState messages retain earlier values for other joints. This chunk does not interpolate joint positions. Frame ids stay inside the recording and topic namespace. Sources with a separate nested TF graph do not receive this robot's supplemental edges.

## Loader choice and limits

The implementation evaluated Apache-2.0 `urdf-loader` 0.13.1. Its parser creates mutable Three.js objects, starts resource loading, and requires browser DOM APIs. Adapting that hierarchy into the controller's serializable model would leave two transform representations. A focused parser uses MIT-licensed `@xmldom/xmldom` and Three.js's existing STL and Collada loaders.

The parser supports visual boxes, cylinders, spheres, and scaled meshes. Mesh loading accepts local STL and DAE files. Unresolved paths, resource failures, unsupported geometry or joint types, and invalid XML produce visible messages. Revolute and prismatic joints clamp to their lower and upper limits. Continuous joints have no position limits. SDF, mimic, planar and floating joints, collision geometry, and joint velocity or effort visualization are outside this chunk.

## Verification result

Node 22.23.4 ran `npm ci`, `npm run compile`, `npm test`, and `npm run check-format` successfully. `npm run wasm:compile` passed with Emscripten 4.0.12. The test command passed all 160 tests across its four test runs. The 16 URDF cases cover parsing, all supported joint transforms, limits, resource paths, the real bag reader, frame integration, seeking, partial updates, and source isolation. [checks.txt](checks.txt) contains the actual command output.

The one app launch used `npm start -- --no-sandbox`. `DISPLAY` was unset. Electron failed before display initialization with `Failed to get 'userData' path` and exited with SIGTRAP. [app-launch.txt](app-launch.txt) contains the output. No retry, virtual display, or display workaround was attempted. The two cursor screenshots and the WPILib screenshot are unavailable. Visual rendering remains unverified in this environment.

`RobotManager.ts`, `MechanismController.ts`, and `LogMechanismState.ts` have no diff against main. URDF defaults to None, and the existing WPILib paths remain in place. This is source-level preservation evidence, not a visual comparison.

## Workflow

The figure-it-out workflow separates architecture review, implementation, fixture generation, independent review, and final verification. One owner changes the application integration and tests. The root agent owns the fixture generator, documentation, command evidence, and PR. Dependency writes serialize with installation.

Model the Domain led to typed joints and visual geometry. Foundational Thinking put graph ownership before rendering. Build the Lever produced the fixture generator. Prove It Works led to the recorded command output and the explicit limitation on visual verification.

Skipped outside Cursor: deslop, Bugbot, and control-ui. These tools are unavailable. Independent code review and the app launch check cover this change. Origin is unavailable, so GitHub CLI is the fallback forge for git operations. PR creation uses the provided GitHub tool.
