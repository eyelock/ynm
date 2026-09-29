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
```

For "why", read `docs/adr/README.md` and the ADR it points to; for "how", `docs/how-to/`; for what
each memory type is for, `docs/explanation/memory-types.md`. Say plainly which source an answer
came from. Do not guess at flags: `--help` runs nothing and is always safe.
