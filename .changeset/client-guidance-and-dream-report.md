---
"@ynm/cli": patch
"@ynm/models": patch
"@ynm/service": patch
---

- For Claude Code, a project with no instruction file now gets `CLAUDE.md`, not `AGENTS.md`, and a project with only an `AGENTS.md` keeps the block there and gets a `CLAUDE.md` that imports it.
- `ynm init` always excludes personal files (`.claude/settings.local.json`, `CLAUDE.local.md`) in `.git/info/exclude`, even when a global ignore file already covers them.
- The dream report's `fallback` now means a no-model path was used; an uncalibrated judge is reported separately as `uncalibrated`, and a reflection the Writer wrote is no longer a fallback.
- The `claude` Writer and the `claude --version` probe run in a dedicated temp directory with `--no-session-persistence`, so the project's CLAUDE.md, hooks and session history are not touched.
