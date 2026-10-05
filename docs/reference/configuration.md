# Configuration reference

Every configuration key, where it is read from, and every environment variable ynm reads. The
key tables are generated from the configuration schemas; the prose around
them is not.

## Files and precedence

ynm reads up to three JSON files and then the environment. Later layers win:

| Order | Source | Read when |
|---|---|---|
| 1 | Built-in defaults (the tables below) | always |
| 2 | `~/.ynm/config.json` (`$YNM_HOME/config.json`) | always |
| 3 | `<repo>/.ynm/config.json` | inside a git repository; `<repo>` is the main work tree |
| 4 | `<worktree>/.ynm/config.local.json` | inside a git repository; the current work tree |
| 5 | `YNM_*` environment variables | always |

Layers are merged one top-level key at a time: a key set in a later layer replaces the whole
value from an earlier one. A `dream` block in `<repo>/.ynm/config.json` therefore replaces the
`dream` block from `~/.ynm/config.json` rather than merging into it. Unknown keys are an error.

`ynm init` writes `<repo>/.ynm/config.json` with the anchor; that is the one file a team
commits. `config.local.json` is for per-clone overrides and is not meant to be committed.
`ynm status` lists the files that were read.

After merging, three keys get runtime defaults when still unset:

| Key | Runtime default |
|---|---|
| `userId` | The OS user name, lowercased, with characters outside `[a-z0-9._-]` replaced by `-` (`me` if none) |
| `personalStore` | `$YNM_HOME/store.git` |
| `actor` | `user:<userId>` |

## Keys

<!-- gen:config-keys -->
| Key | Type | Default | Description |
|---|---|---|---|
| `anchor` | string |  | Anchor commit for this repository's distributed notes |
| `remote` | string | `origin` | Remote used by sync |
| `provider` | `git-notes` \| `fs` \| `sqlite` \| `memory` | `git-notes` | Default provider |
| `personalStore` | string |  | Path of the personal bare repo; default ~/.ynm/store.git |
| `userId` | string |  | Used for the default personal namespace user/<id> |
| `actor` | string |  | Provenance actor for writes from this machine |
| `redaction` | array of string | [six patterns](#default-redaction-patterns) | Regex patterns that block distributed writes |
| `mounts` | array of object |  | Explicit extra mounts (org stores, hosted stores) |
| `mounts[].id` | string |  | Mount id, shown on every hit and accepted by `--mount` |
| `mounts[].level` | `personal` \| `distributed` |  | Which records the mount accepts |
| `mounts[].provider` | `git-notes` \| `fs` \| `sqlite` \| `memory` \| `s3` \| `mcp` | `git-notes` | Record store provider for this mount; `mcp` is a hosted ynm reached over MCP, signed in with `ynm login <id>` |
| `mounts[].path` | string |  | Repository or directory path; required by every provider but `s3` and `mcp` |
| `mounts[].url` | string |  | `mcp` only: the hosted store's MCP endpoint, ending in /mcp |
| `mounts[].anchor` | string |  | Anchor commit for this mount's notes |
| `mounts[].remote` | string |  | Remote used when syncing this mount |
| `mounts[].bucket` | string |  | `s3` only: the bucket that holds the store |
| `mounts[].prefix` | string |  | `s3` only: key prefix the store's objects sit under; default the bucket root |
| `mounts[].region` | string |  | `s3` only: AWS region of the bucket; default from the AWS environment |
| `hooks` | boolean | `true` | Install git hooks on init |
| `index` | `sqlite-fts` \| `memory` | `sqlite-fts` | Index implementation |
<!-- /gen:config-keys -->

`anchor` is a full commit id (40 hex characters, or 64 for SHA-256 repositories).

`hooks` is not read by `ynm init` today; the pre-push hook is controlled by `ynm init
--[no-]hooks` alone.

### Mounts and where they live

| Mount | Opened when | `git-notes` location | Other providers |
|---|---|---|---|
| `personal` | always, unless the server runs with `--no-personal` | `personalStore` | `$YNM_HOME/store-<provider>` |
| `project` | the repository has a `.ynm/config.json` | the repository | `<repo>/.ynm/store-<provider>` |
| each `mounts[]` entry | always | `path` | `path` (`sqlite`: `path` if it ends in `.sqlite`, else `path/store.sqlite`; `s3`: `s3://<bucket>/<prefix>`) |

An `s3` mount takes `bucket`, and optionally `prefix` and `region`, instead of `path`.
Credentials come from the standard AWS chain. The provider is in the Docker image and a source
checkout, not in the standalone binaries or the slim tarball; see
[Choose the S3 provider](../how-to/choose-the-s3-provider.md). `s3` is a mount provider only,
not a value for the top-level `provider`.

A `mounts[]` entry with the `git-notes` provider must set `anchor`; opening it fails otherwise.

### Default redaction patterns

Applied to every distributed write and every consolidation write. A pattern that starts with
`(?i)` is matched case-insensitively. Setting `redaction` replaces the list; include these if
you want to keep them.

<!-- gen:redaction-defaults -->
```text
-----BEGIN [A-Z ]*PRIVATE KEY-----
AKIA[0-9A-Z]{16}
gh[pousr]_[A-Za-z0-9]{20,}
sk-[A-Za-z0-9_-]{20,}
xox[baprs]-[A-Za-z0-9-]{10,}
(?i)bearer\s+[A-Za-z0-9._-]{20,}
```
<!-- /gen:redaction-defaults -->

## The dream block

Models and consolidation thresholds, under the `dream` key. See
[Dreaming](../explanation/dreaming.md) for what the bands mean.

<!-- gen:dream-keys -->
| Key | Type | Default | Description |
|---|---|---|---|
| `dream.judge` | `auto` \| `heuristic` \| `typesafe` \| `writer-emulated` | `auto` | Judge seam. `auto`: TypeSafe when its key is set, else emulated over the Writer, else heuristic |
| `dream.writer` | `auto` \| `none` \| `claude-cli` \| `openai-compatible` | `auto` | Writer seam. `auto`: the `claude` CLI when installed, else an OpenAI-compatible endpoint when a key or `YNM_OPENAI_BASE_URL` is set, else none |
| `dream.judgeOnWrite` | boolean | `true` | Run the Judge on the write path when one is available |
| `dream.thresholds` | object |  | Confidence bands per pass |
| `dream.thresholds.dedupe` | object |  | Bands for merging near-duplicates |
| `dream.thresholds.dedupe.act` | number 0..1 | `0.85` | At or above: act (calibrated judge only) |
| `dream.thresholds.dedupe.review` | number 0..1 | `0.6` | At or above: flag for review |
| `dream.thresholds.contradict` | object |  | Bands for resolving contradictions |
| `dream.thresholds.contradict.act` | number 0..1 | `0.85` | At or above: act (calibrated judge only) |
| `dream.thresholds.contradict.review` | number 0..1 | `0.6` | At or above: flag for review |
| `dream.thresholds.promote` | object |  | Bands for promoting working memory |
| `dream.thresholds.promote.act` | number 0..1 | `0.7` | At or above: act (calibrated judge only) |
| `dream.thresholds.promote.review` | number 0..1 | `0.5` | At or above: flag for review |
| `dream.thresholds.reflect` | object |  | Settings for the reflect pass |
| `dream.thresholds.reflect.minEpisodes` | integer >= 2 | `3` | Episodes a subject needs before it is reflected on |
| `dream.thresholds.reflect.flagAt` | number 0..1 | `0.7` | A verification question at or above this withholds the draft |
| `dream.occurrenceRetention` | string or null | `P90D` | How long the expire pass keeps memories tagged `occurrence`, as an ISO 8601 duration since their last change; `null` keeps them forever. Occurrences the newest reflection on their subject links to are always kept |
| `dream.maxPairsPerRun` | integer >= 1 | `2000` | Cap on judged pairs per dream run |
| `dream.candidatesPerMemory` | integer 1..20 | `5` | Nearest neighbours considered per memory |
| `dream.rerank` | boolean | `true` | Judge-backed rerank of the top candidates on recall |
| `dream.rerankTopK` | integer 1..50 | `15` | Candidates the reranker judges |
| `dream.typesafe` | object |  | TypeSafe judge settings |
| `dream.typesafe.model` | string |  | Model id; default: the service's latest Jev |
| `dream.typesafe.apiKeyEnv` | string | `TYPESAFE_API_KEY` | Environment variable holding the key |
| `dream.openai` | object |  | OpenAI-compatible writer settings |
| `dream.openai.baseUrl` | string | `http://localhost:11434/v1` | Endpoint base URL (`YNM_OPENAI_BASE_URL` overrides under `auto`) |
| `dream.openai.model` | string | `qwen3:latest` | Model name (`YNM_OPENAI_MODEL` overrides under `auto`) |
| `dream.openai.apiKeyEnv` | string | `OPENAI_API_KEY` | Environment variable holding the key |
| `dream.claude` | object |  | Claude CLI writer settings |
| `dream.claude.model` | string |  | Model passed to `claude -p`; default: the CLI's own |
| `dream.claude.useApiKey` | boolean | `false` | Keep `ANTHROPIC_API_KEY` for the CLI. By default it is removed so the CLI uses your Claude Code login |
<!-- /gen:dream-keys -->

An uncalibrated judge (`heuristic`, `writer-emulated`) never reaches the act band: at or above
`act` it flags for review instead.

## Environment variables

### Configuration

| Variable | Effect |
|---|---|
| `YNM_HOME` | Home for `config.json`, `env`, the personal store and personal indexes. Default `~/.ynm` |
| `YNM_ANCHOR` | Overrides `anchor` |
| `YNM_REMOTE` | Overrides `remote` |
| `YNM_PROVIDER` | Overrides `provider` |
| `YNM_PERSONAL_STORE` | Overrides `personalStore` |
| `YNM_USER` | Overrides `userId` |
| `YNM_ACTOR` | Overrides `actor` |
| `YNM_INDEX` | Overrides `index` |
| `YNM_MOUNTS` | Replaces `mounts` with this JSON array, for a server configured by environment alone (a container or a Lambda function) |

### Secrets and models

Secrets are loaded from `$YNM_HOME/env` and then from a `.env` at the repository root, as
`KEY=VALUE` lines (`export` prefixes and quotes allowed). Neither overrides a variable that is
already set.

| Variable | Effect |
|---|---|
| `TYPESAFE_API_KEY` | TypeSafe judge key. The name is `dream.typesafe.apiKeyEnv`. With `judge: auto`, its presence selects the TypeSafe judge |
| `OPENAI_API_KEY` | OpenAI-compatible writer key. The name is `dream.openai.apiKeyEnv` |
| `YNM_OPENAI_BASE_URL` | With `writer: auto`, selects the OpenAI-compatible writer at this URL, overriding `dream.openai.baseUrl` |
| `YNM_OPENAI_MODEL` | With `writer: auto`, overrides `dream.openai.model` |
| `YNM_NO_CLAUDE_CLI` | `1` skips probing for the `claude` CLI when `writer` is `auto` |
| `YNM_TOKEN_BUDGET` | Cap on model input tokens per process. Default 2,000,000 |

### Server

Read by `ynm serve` and `ynm-mcp`. Auth mode is chosen in this order: `--token`, then
`YNM_JWKS_URL`, then `YNM_OAUTH_INTROSPECTION_URL`, then `YNM_MCP_TOKEN`, then none.

| Variable | Effect |
|---|---|
| `YNM_JWKS_URL` | Verify bearer tokens as JWTs against this JWKS. A token's `iss` and `sub` identify a person; one with no `sub` writes as `client:<azp or client_id>`, else as the server's own actor |
| `YNM_JWT_ISSUER` | Required JWT issuer. Also advertised to clients as where to sign in, at `/.well-known/oauth-protected-resource` |
| `YNM_JWT_AUDIENCE` | Required JWT audience. When it is a URL and `YNM_PUBLIC_URL` is not set, it is the resource advertised to clients |
| `YNM_PUBLIC_URL` | The URL clients use to reach the server, advertised as the resource tokens must be issued for |
| `YNM_OAUTH_INTROSPECTION_URL` | Verify bearer tokens by RFC 7662 introspection at this URL. A response with no `sub` writes as `client:<client_id>`, else as the server's own actor |
| `YNM_OAUTH_CLIENT_ID` | Client id for introspection |
| `YNM_OAUTH_CLIENT_SECRET` | Client secret for introspection |
| `YNM_MCP_TOKEN` | Static bearer tokens, comma-separated. A shared secret: every caller using one is the same identity, and what they write is recorded as `token:static` |
| `YNM_REQUIRED_SCOPES` | Scopes every token must carry, comma-separated |
| `YNM_AUDIT` | Where each request's audit event goes, as JSON: `{"sink":"stdout"}`, `{"sink":"file","path":"/var/log/ynm/audit.jsonl"}`, `{"sink":"s3"}` (optional `bucket`, `prefix`, `region`; on an S3 store the bucket defaults to the store's and the prefix to `audit/<store prefix>`), `{"sink":"otel"}` (each event an OpenTelemetry event sent with ynm's telemetry, which must be on; the person appears as their sign-in id qualified by the identity provider's host), or `{"sink":"off"}`. Unset: stdout when the server checks tokens, else off. Events hold metadata only: when, who (person id and client; a static token has no person and client `static`, and a token with no subject has no person and the client it names), which tools, outcome, duration, memory ids and sizes, never content |
| `YNM_HTTP_HOST` | Bind host when `--host` is not given. Default `localhost` |
| `PORT` | Port when `--port` is not given. Default 3000 |
| `YNM_ALLOWED_HOSTS` | Allowed `Host` headers when `--allow-host` is not given, comma-separated |
| `YNM_DREAM_EVERY` | Consolidation interval when `--dream-every` is not given |
| `YNM_SYNC_EVERY` | Sync interval when `--sync-every` is not given |

### Docker image

| Variable | Effect |
|---|---|
| `YNM_STORE` | Path of the bare repository the container creates or adopts and serves. Default `/data/store.git` |
| `YNM_GIT_DAEMON` | `1` also serves the store over `git://` |
| `YNM_URL` | Server URL used by the compose demo's agent |

The image also sets `YNM_HOME=/data/home`, `YNM_HTTP_HOST=0.0.0.0` and `YNM_NO_CLAUDE_CLI=1`.

### AWS Lambda

The function ([Host ynm on AWS Lambda](../how-to/host-on-aws-lambda.md)) reads the server's
auth variables (`YNM_JWKS_URL` and the rest, `YNM_REQUIRED_SCOPES`) and the configuration
variables above, `YNM_MOUNTS` for its store, plus:

| Variable | Effect |
|---|---|
| `YNM_PUBLIC_URL` | Required. The URL clients use to reach the function, such as `https://memory.example.com/mcp`. Requests are served as if addressed to it, and it is the only allowed `Host`. With JWT auth and an issuer, it is also the resource advertised to clients for sign-in. The function refuses to start without it |
| `YNM_LAMBDA_ALLOW_OPEN` | `1` lets the function start with no authentication configured. Without it, a function with none of the auth variables refuses to start, because a Function URL is public. For local tests only |
| `YNM_SSM_ENV_PATH` | A Parameter Store path; at cold start each parameter under it named like an environment variable becomes that variable unless already set, so secrets stay out of the function's configuration. Values of `unset` are skipped |

On Lambda, `YNM_HOME` defaults to `/tmp/ynm` and `YNM_NO_CLAUDE_CLI` to `1`. The port, bind host,
allowed-host and interval variables do not apply.

### Telemetry

Read by every command and server. Telemetry is off, and no OpenTelemetry code is loaded, until an
endpoint is set; see [Send telemetry to an OpenTelemetry collector](../how-to/send-telemetry.md).
`ynm hook` never sends telemetry.

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Turns telemetry on: spans, events, logs and metrics go to this OTLP/HTTP endpoint |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | One signal's full URL; set alone, only that signal is sent |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json`, also per signal. `grpc` is not supported |
| `OTEL_EXPORTER_OTLP_HEADERS` | Headers sent with each export, also per signal |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Milliseconds one export may take, retries included. Default 10000; a command and a stdio server use at most 2000 |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` | `none` turns that signal off |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between metric exports. Default 60000 |
| `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME` | Resource attributes; they win over ynm's `service.name`, `service.version` and `service.instance.id` |
| `OTEL_SDK_DISABLED` | `true` turns telemetry off whatever else is set |
| `TRACEPARENT`, `TRACESTATE` | The W3C trace a command or stdio server joins |
| `YNM_TELEMETRY_NAMESPACES` | `1` adds the namespace a store call was limited to (`ynm.namespace`) to its span. Off by default, because a namespace can name a person |

### Internal

| Variable | Effect |
|---|---|
| `YNM_SYNC_IN_PROGRESS` | Set by sync on its own git calls; the pre-push hook exits when it sees it |
| `YNM_BIN` | Path of the `ynm` binary the Pi extension runs. Default `ynm` on `PATH` |

### Evals and development

| Variable | Effect |
|---|---|
| `YNM_EVAL_CALIBRATED` | `1` lets model-backed evals use a paid judge when its key is set |
| `YNM_EVAL_CLAUDE_CLI` | `1` lets evals use the `claude` CLI as a writer, and runs the tutorial and hosted-remember evals |
| `YNM_EVAL_TOKEN_BUDGET` | Input-token cap per eval suite. Default 250,000 |
| `YNM_EVAL_MODEL` | Model for the live guidance, hosted-remember and tutorial evals. Default `claude-sonnet-4-5` |
| `YNM_EVAL_SIZE` | Seeded memories in the model-backed dedupe eval. Default 60 |
| `YNM_EVAL_CLEANUP_SIZE` | Seeded memories in the model-backed cleanup eval. Default 120 |
| `YNM_BENCH_LARGE` | `1` adds the 100,000-record sizes to the latency benches |
| `YNM_BENCH_CASES` | Cases per public benchmark dataset. Default 60 |
| `YNM_BENCH_ANSWER` | `1` answers a bounded sample in the public benchmarks |
| `YNM_BENCH_ANSWER_LIMIT` | Cases answered per dataset with `YNM_BENCH_ANSWER=1`. Default 20 |
| `YNM_BENCH_DIR` | Where public benchmark datasets are cached. Default `~/.ynm/bench` |
| `YNM_BASELINE_VERSION` | Baseline file version under `packages/evals/baselines`. Default: the CLI package version |
| `YNM_DEV_BUILD` | Set by the `make install` launcher to the checkout path; `ynm --version` then reports `<version>-dev.<sha>` |
| `YNM_REPO` | Path of your ynm checkout, for the tutorial steps that run its `make` targets and scripts. The tutorial evals set it to the checkout under test |
| `YNM_WRITE_BASELINE` | `1` rewrites the baseline file |
| `YNM_WRITE_GOLDEN` | `1` rewrites golden files |
| `YNM_GATE` | Set by `make gate` to the gate being run |
| `YNM_MILESTONE` | CI variable naming the gate CI runs |
