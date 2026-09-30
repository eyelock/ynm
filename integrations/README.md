# Integrations

What ynm installs into your agents. You don't copy anything from here by hand: `ynm client
install` (or `ynm init`, for the clients a repository already uses) writes the right thing into
each client's config and tells you what it wrote.

| Directory | What it is | How it reaches your agent |
|---|---|---|
| [`skills/ynm-memory/`](skills/ynm-memory/SKILL.md) | The `ynm-memory` skill: when to recall, what to remember and at which level, and the CLI form of every tool. Plain [Agent Skills](https://agentskills.io) format, so any harness or client that loads skills can use it | A ynh harness includes it (`ynm client install` adds the include); `ynm client install pi` writes it for Pi; for Claude Code, Codex, Copilot CLI or OpenCode, copy it into that client's skills directory if you want it alongside the instruction-file guidance |
| [`ynh/`](ynh/) | A ynh harness: ynm's MCP server, hooks, focuses and the skill (by include) | `ynh install github.com/eyelock/ynm --path integrations/ynh` |
| [`pi/`](pi/) | The Pi extension (Pi has no MCP; the extension runs the ynm CLI) | `ynm client install pi` writes it into `~/.pi/agent/` or `.pi/` |

Claude Code, Copilot CLI and OpenCode get the MCP server, the guidance block and (for Claude
Code) the hooks written directly into their own config by `ynm client install`.

Everything in this directory is generated from ynm's source by `make gen`, and a test fails when
a checked-in file drifts from what the code would write. Edit the generators in
`packages/service/src/clients/`, not these files.

Skills for people working on ynm itself live elsewhere: [`.agents/skills/`](../.agents/skills/).
