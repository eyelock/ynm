# ynm

**Your named memory.** Agent memory in git notes, exposed over MCP and CLI. Sibling of
[ynh](https://github.com/eyelock/ynh) (your named harness): ynh manages the guide layer of an
agent; ynm manages what the agent remembers.

Status: pre-alpha, MVP reached (M3). The architecture is recorded as draft ADRs in
[`docs/adr`](docs/adr/README.md).

## Try it

```bash
pnpm install && pnpm build
alias ynm="node $PWD/packages/cli/bin/run.js"
cd /path/to/your/repo
ynm init                          # anchor, config, shared-only refspecs, pre-push hook
ynm client install claude-code    # .mcp.json + CLAUDE.md guidance block (project scope)
ynm remember --type procedural --level distributed --content "Run pnpm check before pushing"
ynm recall --text "before pushing"
ynm context                       # the session-start block agents read
ynm sync                          # fetch, cat_sort_uniq merge, push shared memory
```

Personal memory lives in `~/.ynm/store.git` and never enters a project repo. Shared memory lives
in `refs/notes/ynm/shared/*` of the project and syncs with its remote. The MCP server is
`ynm-mcp --stdio` (local) or `ynm-mcp --http --port 3000 --token …` (hosted, against a bare repo).
For ynh harnesses: `ynh install github.com/eyelock/ynm`.

## Development

```bash
pnpm install
pnpm build
pnpm check && pnpm typecheck && pnpm test
pnpm gate M0        # milestone gate; see packages/evals/src/gates
```

Requires Node 22 or later and pnpm (via `corepack enable`).

## License

MIT
