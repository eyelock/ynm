# Contributing to ynm

## Build and test

Requires Node 22.13 or later (for `node:sqlite`) and pnpm via `corepack enable`.

```bash
make deps
make build                       # turbo, every package
make check                       # biome lint and format
make typecheck
make test                        # tier 1 evals and unit tests; no keys, no Docker
```

`make coverage` writes each package's report to `packages/<name>/coverage/`; overall totals are
reported, not enforced. `make coverage-diff` then measures line coverage of what your branch
adds or changes against `origin/develop` (`BASE=` to change it) and fails below 80%. CI runs
both on every pull request.

`make rebuild` does all of the above from clean. `make install` gives you a locally addressable
build to test with, ynh-style: it writes `~/.ynm/bin/ynm`, a launcher that runs this checkout, and
prints the PATH line if that directory is not on your PATH. `ynm --version` then reports
`<version>-dev.<sha>`, and a rebuild is picked up without reinstalling. `make uninstall` removes it.

## Branches and pull requests

ynm uses Gitflow, the same model as [ynh](https://github.com/eyelock/ynh). Nothing is committed
to `main` or `develop` directly: every change goes through a branch and a pull request.

| Work | Branch from | Pull request into |
|---|---|---|
| Feature, fix, docs, CI | `develop` | `develop` |
| Release | `develop`, as `release/vX.Y.Z` | `main`, then back-merged into `develop` |
| Hotfix | the release tag, as `hotfix/<what>` | `main`, then back-merged into `develop` |

Branch names use a slash: `feat/…`, `fix/…`, `docs/…`, `ci/…`, `refactor/…`, `test/…`,
`hotfix/…`. `develop` is the default branch. Feature pull requests are squash-merged; release and
hotfix pull requests into `main` use a true merge, so the back-merge into `develop` is clean.
`main` accepts pull requests only from `develop`, `release/*` or `hotfix/*` (the "Verify PR
source branch" check enforces it), and release tags are cut from `main`.

```bash
git switch develop && git pull
git switch -c feat/my-change
# ...work, commit...
git fetch origin develop && git merge origin/develop
git push -u origin feat/my-change
gh pr create --base develop
```

### Before anything leaves your machine

Before `git push` or opening a pull request:

1. `make verify` passes (check, typecheck, every package's tests).
   `make coverage coverage-diff` shows changed lines at 80% or more.
2. `make test-tutorials` passes; if the change touches a tutorial or anything a tutorial runs,
   `make eval-tutorials` for those tutorials too (opt-in, spends tokens).
3. Generated files are current: `make gen` after tool or client changes, `make docs-gen` after
   CLI or schema text changes (the drift test fails otherwise).
4. A user-visible change ships with its docs in the same pull request.
5. After pushing, CI is green before merging: `gh pr checks <number> --watch`.

## Layout

| Package | Holds |
|---|---|
| `packages/model` | Record and query schemas (Zod), ULIDs, the guidance markdown agents receive |
| `packages/store` | The append-only record log: git-notes, sqlite, fs and memory providers, fold, sync |
| `packages/store-s3` | The s3 provider, apart so the AWS SDK stays out of the CLI bundles; an in-memory S3 double for tests |
| `packages/index` | Recall: SQLite FTS index, ranker, context packing |
| `packages/models` | Judge and Writer seams: TypeSafe, heuristic, Claude CLI, OpenAI-compatible, spend guard |
| `packages/service` | The one business layer: mounts, remember, recall, dream, wiki, client adapters, tool specs |
| `packages/mcp` | MCP server, stdio and HTTP transports, auth verifiers, hosted scheduler |
| `packages/cli` | oclif commands; flags generated from the same schemas the tools use |
| `packages/wiki` | Markdown projection of memory |
| `packages/evals` | Tiered evals, milestone gates, benchmark drivers, baselines and reports |

Design decisions are ADRs under [`docs/adr`](docs/adr/README.md). They are accepted; a change
of decision gets a new ADR, not an edit.

## Evals and gates

- `make test` runs tier 1 (deterministic, free). Latency benches: `make bench`.
- Hosted integration (needs a Docker daemon): `make test-hosted`.
- Tutorials are acceptance tests: `make test-tutorials` runs every command
  block; `make eval-tutorials` has a model read, run
  and check them. See [Running tutorials as evals](docs/tutorial/RUNNING.md).
- `make eval-hosted-remember` (opt-in, spends tokens) connects Claude Code to a hosted server by
  URL alone, with no hooks or instruction file, and checks that remember requests reach ynm.
- Tier 2 (model-backed) suites run by path under `packages/evals/src/tier2`. Paid judges need
  both a key and `YNM_EVAL_CALIBRATED=1`; spend is capped by `YNM_EVAL_TOKEN_BUDGET`.
- Tier 3 public benchmarks: `make bench-public` (retrieval only; `YNM_BENCH_ANSWER=1` answers a
  bounded sample). Reports live in `packages/evals/reports/<version>/`.
- Milestone gates: `make gate M=M<n>`. CI runs the gate named by the `YNM_MILESTONE` variable;
  move it with `gh variable set YNM_MILESTONE --body M<n>`.
- Baselines in `packages/evals/baselines/<version>.json`; `YNM_WRITE_BASELINE=1` rewrites them,
  and a PR that moves a gated number updates the baseline in the same PR.

## Secrets

Keys go in `~/.ynm/env` or a gitignored `.env` at the repo root, never in config or code. The
eval support loads the repo `.env`, which is why calibrated runs are also gated by an explicit
variable.

## Conventions

- Milestone ids appear only in gate files and ADR history lines, never in code, test names or
  content.
- Generated, checked-in artefacts under `integrations/` (the `ynm-memory` skill, the ynh harness and the Pi extension) are regenerated by
  `make gen`; a test fails when they drift.
- The CLI and MCP references, the key tables in the configuration, record-format and
  memory-types references, and the tutorial manual test plan are generated by `make docs-gen`
  (after `make build`); a test fails when they drift, when a link or anchor under `docs/` is
  broken (`make docs-links`), or when a `YNM_*` variable is missing from the configuration
  reference.
- Golden files under `packages/*/test/golden` are rewritten with `YNM_WRITE_GOLDEN=1`.
- Tutorials follow the shape in `docs/tutorial/RUNNING.md`; a new CLI feature gets a tutorial
  step and an Expected block, and the smoke test runs it.

## Releasing

See [Cut a release](docs/how-to/cut-a-release.md).
