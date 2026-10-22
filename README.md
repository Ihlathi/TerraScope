# TerraScope

**Any robot. Any framework. Any data. One scope.**

TerraScope is an open-source, framework-independent platform for robotics telemetry, visualization, recording, debugging, and analysis. The aim is one place to understand a robot, or any other system that produces timestamped data, whether the stream is live or a recording.

This repository is a fork of [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScope), the robot diagnostics and log-analysis application developed by [Littleton Robotics (FRC 6328)](https://littletonrobotics.org). TerraScope keeps that application working, including its log formats and live sources, and uses it as the base for a broader tool. AdvantageKit is not required.

The direction for that work is in [ROADMAP.md](ROADMAP.md). How the current code is put together is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The pull-request sequence is in [docs/PLAN.md](docs/PLAN.md).

## What the application does today

The inherited AdvantageScope tools are unchanged:

- A wide selection of flexible graphs and charts
- 2D and 3D field visualizations of pose data, with customizable CAD-based robots
- Synchronized video playback from a separately loaded match video
- Joystick visualization, showing driver actions on customizable controller representations
- Swerve drive module vector displays
- Console message review
- Log statistics analysis
- Flexible export options, with support for CSV, WPILOG, and MCAP

It reads WPILOG, Hoot (CTRE), REVLOG (REV Robotics), Road Runner, CSV, NI Driver Station, and RLOG files, and views live data over NetworkTables 4, Phoenix diagnostics, RLOG, or FTC Dashboard.

**View the [AdvantageScope documentation](https://docs.advantagescope.org) or find it offline by clicking the 📖 icon in the tab bar.** Those docs still describe the inherited features and use AdvantageScope's names for them.

[![Build](https://github.com/Ihlathi/TerraScope/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/Ihlathi/TerraScope/actions/workflows/build.yml)

## Record without a window

Use Node.js 22 or newer. Install the dependencies and compile the command from the repository root.

```sh
npm ci
npm run compile
npm run record -- --source 10.0.0.2 --output session.wpilog --duration 60
```

The command records all NT4 fields with the same live source and incremental WPILOG writer as the app. It does not launch Electron. The destination file is overwritten if it exists. Open the resulting `.wpilog` file in TerraScope.

To use another NT4 port, pass `--source robot.local:5811`. Omit `--duration` to record until Ctrl-C. The duration starts at the first connection. Ctrl-C and SIGTERM drain accepted samples, sync the file, and close it before exit.

Status lines report `connected`, the number of recorded `fields` and `samples`, the `bytes` written, and `free` disk bytes. The command exits with code 0 after a normal stop, code 1 after a connection or storage failure, and code 2 for invalid arguments.

The connection timeout is 10 seconds and also applies after a lost connection. Set `--connect-timeout 30` to change it. Recording stops when free disk space falls below 64 MiB. Set `--minimum-free-bytes` to change that threshold. Run `npm run record -- --help` for the options.

This command supports one NT4 source and WPILOG output. Other live protocols, file rotation, and tagged clock-domain restoration are outside this command.

## Attribution

AdvantageScope is copyright 2021–2026 Littleton Robotics and its contributors. TerraScope does not replace that copyright and is not endorsed by Littleton Robotics, FRC 6328 ("Mechanical Advantage"), or the AdvantageScope contributors.

Use of the source is governed by the BSD 3-Clause license in [LICENSE](LICENSE). File headers, the license text, and third-party notices are kept. [NOTICE](NOTICE) lists what this fork changed. See [CONTRIBUTING.md](CONTRIBUTING.md) before sending changes. TerraScope issues and pull requests belong on [Ihlathi/TerraScope](https://github.com/Ihlathi/TerraScope). Please do not open TerraScope issues against the upstream AdvantageScope repository.

Upstream contact for AdvantageScope itself remains software@team6328.org.

![Example screenshot](/docs/docs/img/screenshot-light.png)
