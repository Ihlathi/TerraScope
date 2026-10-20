# pstack in Codex, Jules, and other non-Cursor agents

`.agents/skills/` is a vendored copy of [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (poteto), MIT licensed (see `skills/PSTACK-LICENSE`). Two Cursor-only skills (`make-bot-ui`, `setup-pstack`) are left out. Do not edit these files to fit TerraScope; put project rules in `AGENTS.md`.

The skills are written for Cursor. Map Cursor names like this:

- "Run the **name** skill", `/name`, or "the **name** skill": read `.agents/skills/<name>/SKILL.md` and follow it. In Codex, `$name` also invokes it.
- Leaf principles named in poteto-mode, such as **Model the Domain**: read `.agents/skills/principle-<kebab-title>/SKILL.md`.
- `Task`, `poteto-agent`, subagents, swarm, arena, interrogate, and multi-model review: use your own subagent feature if you have one. If you do not, do the step yourself in sequence and say in one line that it ran single-agent.
- Model slugs (`claude-*`, `grok-*`, `gpt-*`) and `/setup-pstack`: ignore them and run on your session model.
- `AskQuestion`: ask in plain text, but only for the product or preference calls poteto-mode reserves for the human. In a cloud task with no human available, pick the default, do it, and explain it in the PR description.
- Bugbot, Cursor automations, Cursor cloud agents, Origin, the `deslop` skill, and the `control-ui` / `control-cli` skills: skip the step and add a line to the PR description, `Skipped outside Cursor: <step>. <reason>.` For UI verification, launch the app and take a screenshot instead.
- `.cursor/rules` and `.cursor/skills`: `AGENTS.md` and `.agents/skills/`.
