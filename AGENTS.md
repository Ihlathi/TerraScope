# Agent instructions for TerraScope

TerraScope is a fork of [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScope) that aims to become a framework-independent robotics telemetry, visualization, recording, and replay tool. These rules apply to every coding agent working in this repository (Cursor, Codex, Jules, Gemini, or a human).

Read these first, in order:

1. [ROADMAP.md](ROADMAP.md): the vision and full feature list. It is direction, not a mandate.
2. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the current data pipeline and the seams where new formats, protocols, and views plug in.
3. [docs/PLAN.md](docs/PLAN.md): the ordered list of PR-sized chunks. Take the lowest-numbered chunk that is not done unless you were given a specific one.

## How to work

- **One chunk, one PR.** Keep each PR to a single focused change from `docs/PLAN.md`. Branch from the latest `main`. Do not stack on unmerged branches.
- **Model the domain first.** Get the types and data structures right before writing logic. Make illegal states unrepresentable where TypeScript allows it.
- **Respect the layers.** Ingestion, transport, serialization, semantic interpretation, and rendering stay independent (ROADMAP section 42). A new file format adds a reader, not a renderer. A new protocol adds a transport or live source, not a decoder inside a view.
- **Fix root causes.** Trace a bug to where things first go wrong and fix it there. Add a guard only when the state it handles is legitimate.
- **Smallest change that works.** Prefer deleting code to adding layers. No speculative abstractions, no compatibility shims for code you are replacing in the same PR.
- **No padding comments.** Comment only what the code cannot say for itself.
- **Do not break existing behavior.** Every existing AdvantageScope log format, live source, tab, and saved layout must keep working.

## Done-check (required before a PR is ready)

Run all of these and paste the results into the PR description:

```bash
npm ci
npm run wasm:compile   # needs Emscripten 4.0.12; skip only if your environment cannot install it, and say so
npm run compile
npm test
npm run check-format   # run `npm run format` to fix
```

- New behavior has tests. Add new test files to the `test` script in `package.json`.
- Any visible UI change is verified by launching the app (`npm start` after compiling) and attaching a screenshot to the PR.
- New source files carry the license header (`npm run format` adds it).
- CI (`.github/workflows/ci.yml`) must pass on the PR.

## PR description

State what changed, which `docs/PLAN.md` chunk it covers, the done-check output, what was verified by hand (with screenshots for UI), and anything risky or left out. When a chunk finishes, mark it done in `docs/PLAN.md` and check the matching items in `ROADMAP.md` in the same PR. Check an item only if the code actually supports it.

## Hard limits

- Open PRs only against `Ihlathi/TerraScope`. Never open PRs or issues on the upstream Mechanical-Advantage repository.
- Never force-push `main`. Never rewrite published history.
- Do not change repository settings, visibility, collaborators, or secrets.
- Do not publish packages, releases, or tags.
- Do not add paid services or dependencies that phone home. TerraScope must work offline.
- Keep the BSD-3-Clause `LICENSE`, the copyright headers, `NOTICE`, and the attribution to AdvantageScope and its contributors. Do not use Littleton Robotics, FRC 6328, or AdvantageScope to endorse TerraScope.
- Do not rename the npm package, app id, protocols, or log formats unless a plan chunk says to.
