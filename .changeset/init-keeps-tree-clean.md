---
"@ynm/service": minor
"@ynm/cli": minor
---

`ynm init` leaves `git status` as it found it. It never edits a tracked file (a tracked client file is left alone and named on a `left` line), registers the Claude Code server with `claude mcp add --scope local` instead of writing `.mcp.json`, appends no guidance block to a project instruction file, and excludes `.ynm/` and every client file it creates in `.git/info/exclude`. `ynm client install` still writes the shareable files.
