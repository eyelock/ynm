---
"@ynm/cli": patch
---

Document the project setup for Claude Code that leaves the user's own client configuration untouched (`ynm init --no-clients`, then `ynm client install claude-code`, committing `.mcp.json` and `CLAUDE.md`), say in `ynm init --help` which route writes the user's Claude Code config, and test that the setup writes only project files and that a fresh clone reads the first clone's distributed memories (ynm #195).
