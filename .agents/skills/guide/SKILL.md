---
name: ynm-guide
description: Answer questions about ynm from what can be read or run: the CLI describes itself, the docs and ADRs hold the why.
---

# guide

Prefer running over recalling:

```bash
ynm --help                # every command
ynm <command> --help      # flags, generated from the tool schema
ynm status                # mounts, shards, index freshness
ynm doctor                # refspecs, hooks, anchor, shards, clients
ynm serve --help          # the MCP server (stdio or --http)
ynm client status         # per agent client: server, guidance, hooks
```

`ynm hook <session-start|prompt|stop>` is what an agent client's hooks run: it reads the
client's hook JSON on stdin and prints JSON on stdout. To see what a hook gives the agent, pipe
it a sample, e.g. `echo '{"prompt":"remember I use tabs"}' | ynm hook prompt`. `ynm init`
installs the hooks for the clients the project uses, Claude Code's into
`.claude/settings.local.json` (ADR-016).

For "why", read `docs/adr/README.md` and the ADR it points to; for "how", `docs/how-to/`; for what
each memory type is for, `docs/explanation/memory-types.md`. Say plainly which source an answer
came from. Do not guess at flags: `--help` runs nothing and is always safe.
