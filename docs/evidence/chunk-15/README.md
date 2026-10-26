# URDF verification

The 3D tab loads one local URDF or a logged `robot_description` and positions its links from named JointState samples at the timeline cursor. Boxes, cylinders, spheres, local STL meshes, and local DAE meshes render through the shared frame graph. Logged TF retains ownership of overlapping child frames.

Revolute and prismatic joints clamp to their limits. Continuous joints rotate without limits. Mimic joints apply `multiplier * position + offset`, including chains. Planar and floating joints stay fixed and produce visible diagnostics. Unsupported visual geometry is skipped with a diagnostic. SDF, collision geometry, interpolation, and velocity or effort visualization remain outside this change.

Named materials share renderer resources across links. Parsed robot IDs survive satellite serialization so playback updates poses without rebuilding the model. COLLADA Y_UP meshes rotate 90 degrees about X into URDF Z-up. Z_UP meshes retain their authored axes.

JointState caches index appended samples without revisiting earlier samples. Tests instrument range access, including a 198-sample append burst, live namespace projection, correction, trimming, field replacement, and clock offset changes. The 3D controller discovers URDF topics once per field refresh and excludes description and JointState subscriptions when URDF is None.

Saved layouts contain opaque local source references instead of robot XML or absolute file URLs. The desktop stores the corresponding paths in `userData/urdf-sources.json`. References persist across restarts on the same computer. A layout opened on another computer asks the user to select unavailable local sources again. Old layouts still load their embedded XML and migrate existing file URLs into references.

## Fixtures and replay

Run `python3 scripts/generate-urdf-fixture.py` to regenerate the robot, STL carriage, DAE tool, and ROS 2 sqlite3 bag under `src/hub/dataSources/ros2/fixtures/urdf/`. The generator uses the Python standard library. Its geometry is authored for this fixture under the repository's BSD license.

Open `robot.db3`, select `/robot_description`, select the fixture directory with **Logged mesh directory**, and select its `packages` directory with **Package root**. Alternatively, load `robot.urdf` directly. At cursor 1.5, the shoulder and slider are zero. At 2.5, they are 1 radian and 0.7 meters. The second sample reverses the joint-name order. At 3, samples exceed the joint limits. A static transform connects `map` to `base_link`.

## Real application screenshots

Start a virtual display and Electron after compilation.

```bash
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 XDG_CONFIG_HOME=/tmp/ts/config XDG_DATA_HOME=/tmp/ts/data XDG_CACHE_HOME=/tmp/ts/cache npm start -- --no-sandbox --disable-gpu --remote-debugging-port=9222
node docs/evidence/chunk-15/verify-urdf.cjs urdf
node docs/evidence/chunk-15/verify-urdf.cjs wpilib
```

The verifier opens the real bag reader, asserts rendered links and poses at both cursor times, checks rewind, generates a tall Y_UP DAE, asserts its rotation and normals, and captures screenshots with CDP `Page.captureScreenshot`. Temporary verification fixtures go under `build/urdf-visual-verification`.

For the WPILib comparison, launch current main in another checkout on port 9223 with the same bundled assets. Run the following command from this branch.

```bash
SCENE_PORT=9223 node docs/evidence/chunk-15/verify-urdf.cjs wpilib-main
```

The verifier generates a WPILOG containing a typed WPILib Pose3d, opens it through the WPILOG reader, and renders the bundled KitBot with URDF set to None. [wpilib-compatibility.json](wpilib-compatibility.json) records identical robot commands and zero changed pixels across the 980 by 484 scene canvas against main `74591d98`. The full-window screenshots retain the different settings controls between branches.

![URDF at cursor 1.5](https://raw.githubusercontent.com/Ihlathi/TerraScope/84e0a2148e818a83d4c26e0c1faf19c275ecf5ed/docs/evidence/chunk-15/urdf-1.5.png)
![URDF at cursor 2.5](https://raw.githubusercontent.com/Ihlathi/TerraScope/84e0a2148e818a83d4c26e0c1faf19c275ecf5ed/docs/evidence/chunk-15/urdf-2.5.png)
![Y_UP DAE upright in Z-up](https://raw.githubusercontent.com/Ihlathi/TerraScope/84e0a2148e818a83d4c26e0c1faf19c275ecf5ed/docs/evidence/chunk-15/dae-y-up-upright.png)
![Existing WPILib robot](https://raw.githubusercontent.com/Ihlathi/TerraScope/84e0a2148e818a83d4c26e0c1faf19c275ecf5ed/docs/evidence/chunk-15/wpilib-robot.png)
![Existing WPILib robot on main](https://raw.githubusercontent.com/Ihlathi/TerraScope/84e0a2148e818a83d4c26e0c1faf19c275ecf5ed/docs/evidence/chunk-15/wpilib-robot-main.png)

## Checks and workflow

[checks.txt](checks.txt) contains the actual Node 22 installation, compile, test, format, WebAssembly, and CDP verification output. [decisions.tsv](decisions.tsv) retains the decision trail and supersedes the prior run's missing-screenshot result. Xvfb was downloaded and extracted locally after `apt-get` failed for lack of system privileges. The app then launched with the required XDG paths and display. [app-launch.txt](app-launch.txt) records the real launch.

The figure-it-out workflow framed the done predicate, split changes by module ownership, ran regression tests, reviewed the code independently, and verified the real app before updating PR 23. Model the Domain led to explicit mimic coefficients and source references. Build the Lever produced the fixture and CDP verifier. Prove It Works required actual screenshots and a main comparison.

Skipped outside Cursor: deslop and control-ui are unavailable. Source review, automated tests, and the Electron verifier cover the work. Origin is unavailable, so GitHub CLI updates the existing PR. No new PR is opened.
