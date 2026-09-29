# ynm

**Your named memory.** Agent memory in git notes, exposed over MCP and CLI. Sibling of
[ynh](https://github.com/eyelock/ynh) (your named harness): ynh manages the guide layer of an
agent; ynm manages what the agent remembers.

Status: pre-alpha, MVP reached (M3). The architecture is recorded as draft ADRs in
[`docs/adr`](docs/adr/README.md).

## Try it

```bash
brew install eyelock/tap/ynm      # or, from a checkout:
pnpm install && pnpm build && alias ynm="node $PWD/packages/cli/bin/run.js"
cd /path/to/your/repo
ynm init                          # anchor, config, shared-only refspecs, pre-push hook
ynm client install claude-code    # also: copilot-cli, opencode, pi, ynh (ADR-013)
ynm remember --type procedural --level distributed --content "Run pnpm check before pushing"
ynm recall --text "before pushing"
ynm context                       # the session-start block agents read
ynm sync                          # fetch, cat_sort_uniq merge, push shared memory
ynm dream --dry-run               # consolidation: expire, promote, dedupe, contradict, reflect, normalise
ynm review list                   # memories a low-confidence decision flagged for a human
ynm wiki build                    # markdown projection under .ynm/wiki (or --target orphan-branch)
```

Consolidation and the write-path checks use two pluggable model seams (ADR-012): a **Judge**
(decision model; TypeSafe Jev when `TYPESAFE_API_KEY` is set, else a heuristic that can only
flag, never act) and a **Writer** (headless `claude -p`, or any OpenAI-compatible endpoint such
as Ollama). Keys go in `~/.ynm/env` or a gitignored `.env`, never in config.

Personal memory lives in `~/.ynm/store.git` and never enters a project repo. Shared memory lives
in `refs/notes/ynm/shared/*` of the project and syncs with its remote. The MCP server is
`ynm serve` (stdio, what clients launch) or `ynm serve --http` (hosted, against a bare repo or
sqlite, with bearer, OAuth introspection or JWT auth and the dream worker on a timer).
For ynh harnesses: `ynh install github.com/eyelock/ynm`.

## Hosted

```bash
docker run -d -p 3000:3000 -v ynm-data:/data -e YNM_MCP_TOKEN=change-me -e YNM_DREAM_EVERY=15m ynm
infra/docker/demo.sh   # store + an agent with no git + a developer clone syncing through it
```

Operations (auth modes, key rotation, backups, scaling): [`docs/how-to/operate-a-hosted-store.md`](docs/how-to/operate-a-hosted-store.md).
Releasing (tarball, Homebrew tap, image): [`docs/how-to/cut-a-release.md`](docs/how-to/cut-a-release.md).

## Benchmarks

Tier 1 and 2 evals run on every change (`pnpm test`, `pnpm bench`); tier 3 drives LoCoMo and
LongMemEval-S through memory and reports evidence recall plus, when opted in, answer accuracy
(`pnpm bench:public`). Reports per release live in `packages/evals/reports/<version>/`; see
[ADR-014](docs/adr/014-evals-and-benchmarks.md) for what the numbers mean and do not mean.

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
