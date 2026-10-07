# Contributing to ynm

## Build and test

Requires Node 22.13 or later (for `node:sqlite`) and pnpm via `corepack enable` (on Node 25 or
later, which no longer bundle corepack, `npm install -g corepack` first).

One dependency, `@eyelock/otel-spool-exporter`, comes from GitHub Packages. The package is public,
but GitHub's npm registry always asks for a token, even to read a public package. The project
`.npmrc` points the `@eyelock` scope at GitHub Packages; building locally needs a GitHub token
with the `read:packages` scope in your user `~/.npmrc`, never in the repository. Any GitHub
account's token works: `gh auth token` is fine if it has `read:packages` (`gh auth status` lists
the scopes), or create a classic token with only `read:packages`:

```bash
echo "//npm.pkg.github.com/:_authToken=<token>" >> ~/.npmrc
# or let npm write it, with the token as the password:
npm login --scope=@eyelock --registry=https://npm.pkg.github.com
```

Without it, `pnpm install` (and `make deps`) fails with `ERR_PNPM_FETCH_401` from
`npm.pkg.github.com`; building and testing an installed checkout do not need it. Users never do:
the release bundles, binaries, Homebrew formulas, Docker image and Lambda package carry the
exporter inside them. CI and the release jobs use the workflow's own token, so no secret is
needed and pull requests from forks work.

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
`<version>-dev.<sha>`, and a rebuild is picked up without reinstalling. Run it from the main checkout,
not a worktree: the launcher points at the directory it was installed from, and `make install`
warns when that is a worktree. If that directory is removed, `ynm` says so and names the checkout
to re-run `make install` from; under `ynm hook` it prints `{}` instead, so an agent session
carries on. `make uninstall` removes it.

## Run the server locally

The MCP server runs three ways, all from the same code: over stdio (what agent clients launch),
over HTTP (the hosted server), and as an AWS Lambda. Each can be tried on this machine against
any store, including an S3 one, and connected to a real agent. Start with `make install`.

### A store to run against

By default a server uses your normal stores (`~/.ynm` and the repository you run it in). To
experiment without touching them, give the shell a scratch home, and optionally an S3 store on a
local MinIO ([`infra/minio`](infra/minio/README.md), needs Docker):

```bash
export YNM_HOME=/tmp/ynm-dev               # a throwaway personal store and index
make minio                                 # MinIO on :9000 with a versioned bucket
eval "$(make minio-env)"                   # AWS_* and YNM_MOUNTS: an s3 mount named hosted
make minio-down                            # when done: stop it, drop its data
```

`YNM_MOUNTS` replaces the mounts from config files for that shell; `unset YNM_MOUNTS` gets yours
back. `ynm status` shows what is mounted (`s3://ynm-dev/dev` for the MinIO mount). Writes to a
mount without a personal level need `--level distributed` (or `level: "distributed"` from an
agent).

### Over stdio

```bash
ynm serve                                  # speaks MCP on stdin/stdout until stdin closes
```

Nothing to look at on its own: connect a client that launches it. In Claude Code,
`claude mcp add ynm-dev -- ynm serve` (pass the scratch settings with `-e`, e.g.
`claude mcp add ynm-dev -e YNM_HOME=/tmp/ynm-dev -- ynm serve`, plus each `minio-env` value for
the S3 store); in the MCP inspector,
`npx @modelcontextprotocol/inspector ynm serve`. `ynm client install <client>` does the same
setup the way users get it.

### Over HTTP

```bash
ynm serve --http --port 3000 --no-personal --token dev-token
curl localhost:3000/health                 # outside auth: auth mode and scheduler stats
```

Connect Claude Code with
`claude mcp add --transport http ynm-dev http://localhost:3000/mcp --header "Authorization: Bearer dev-token"`,
or the inspector with the same URL and header. `--dream-every 1m` runs the dream worker on a
timer, as a hosted server does. The Docker image is the same server: `docker compose -f
infra/docker/docker-compose.yml up`. Building it needs the token too, in `NODE_AUTH_TOKEN`,
passed as a build secret: `NODE_AUTH_TOKEN=$(gh auth token) docker build --secret
id=npm_token,env=NODE_AUTH_TOKEN .` (the compose file passes it for you, and
`make test-hosted` falls back to `gh auth token` when it is unset). The image bundles the CLI
with `node scripts/release/bundle.mjs --with-s3` and copies only `ynm.mjs` into a runtime stage
that runs as uid 1001 (a bind-mounted `/data` must be writable by it).

CI scans for secrets with gitleaks. `.gitleaks.toml` extends the default rules and allowlists
only the test files whose fake credentials check that redaction works, and the placeholder bearer
token in the curl example above.

### As a Lambda

`make lambda-local` builds `dist/lambda.zip`, the package that goes to AWS, and serves it on
`http://localhost:3000/mcp`: each HTTP request becomes the Function URL event the AWS runtime
would send, and the handler's answer becomes the response. One process is one warm instance;
restart it to see a cold start.

```bash
export YNM_MCP_TOKEN=dev-token             # a function refuses to start without auth
make lambda-local                          # PORT=… to move it; Ctrl-C to stop
make lambda-event E=dream                  # one scheduled event (dream, compact, health), printed
```

It is configured the way the function is, by environment: `YNM_PUBLIC_URL` (defaults to the
local URL), `YNM_MOUNTS` (defaults to a sqlite store under `.lambda-local/`, so
`eval "$(make minio-env)"` first to run it on S3 instead), and the auth variables. Connect a client
exactly as for HTTP above. The same S3 store can be served by the Lambda, `ynm serve --http` and
the CLI at once: writes never conflict.

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
hotfix pull requests into `main` use a true merge, so the back-merge into `develop` is clean;
rebase merge is off. Each of `develop` and `main` has a repository ruleset
([`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md)): a pull request with every
conversation resolved, and the one required check, "All Clear", the last CI job, which depends on
the others. `main` accepts pull requests only from `develop`, `release/*` or `hotfix/*` (the "Verify PR
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
5. After pushing, CI is green before merging (the required check is "All Clear"):
   `gh pr checks <number> --watch`.

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
| `packages/telemetry` | OpenTelemetry behind a facade: the SDK and the ynr spool exporter are imported only when an OTLP endpoint is set or a spool is found; constants generated from `telemetry/registry` |
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
- Telemetry names live in the Weaver-format registry under `telemetry/registry/`. `make gen`
  checks it and regenerates `packages/telemetry/src/registry.gen.ts`; a test fails when it is
  stale. Import `@opentelemetry` packages and `@eyelock/otel-spool-exporter` only in
  `packages/telemetry/src/sdk.ts`, its `testing.ts` entry and tests: the bundle build fails if
  one loads at startup.
- Tests run with `YNR_SPOOL` empty and `XDG_STATE_HOME` pointing at a folder that does not exist
  (`packages/shared/vitest`), so a ynr spool on your machine does not turn telemetry on in them.
  A test that spawns ynm with its own environment passes `XDG_STATE_HOME` through.
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
