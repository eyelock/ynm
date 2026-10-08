# @ynm/cli

## 0.4.1

### Patch Changes

- [#80](https://github.com/eyelock/ynm/pull/80) [`1e1263c`](https://github.com/eyelock/ynm/commit/1e1263c9295cdf31009d4f1745f9794c6248cdda) Thanks [@eyelock](https://github.com/eyelock)! - - For Claude Code, a project with no instruction file now gets `CLAUDE.md`, not `AGENTS.md`, and a project with only an `AGENTS.md` keeps the block there and gets a `CLAUDE.md` that imports it.
  - `ynm init` always excludes personal files (`.claude/settings.local.json`, `CLAUDE.local.md`) in `.git/info/exclude`, even when a global ignore file already covers them.
  - The dream report's `fallback` now means a no-model path was used; an uncalibrated judge is reported separately as `uncalibrated`, and a reflection the Writer wrote is no longer a fallback.
  - The `claude` Writer and the `claude --version` probe run in a dedicated temp directory with `--no-session-persistence`, so the project's CLAUDE.md, hooks and session history are not touched.

- [#80](https://github.com/eyelock/ynm/pull/80) [`1e1263c`](https://github.com/eyelock/ynm/commit/1e1263c9295cdf31009d4f1745f9794c6248cdda) Thanks [@eyelock](https://github.com/eyelock)! - `ynm dream --dry-run` no longer calls a model; add `--judge` to see the model's verdicts.

- [#80](https://github.com/eyelock/ynm/pull/80) [`1e1263c`](https://github.com/eyelock/ynm/commit/1e1263c9295cdf31009d4f1745f9794c6248cdda) Thanks [@eyelock](https://github.com/eyelock)! - `ynm remember` warns when similar memories already exist, as the MCP tool does: a `note:` line
  after `remembered ...`, and a `guidance` string in the JSON. It never refuses.
- Updated dependencies [[`1e1263c`](https://github.com/eyelock/ynm/commit/1e1263c9295cdf31009d4f1745f9794c6248cdda), [`1e1263c`](https://github.com/eyelock/ynm/commit/1e1263c9295cdf31009d4f1745f9794c6248cdda), [`696da43`](https://github.com/eyelock/ynm/commit/696da435f5e38a0d678669199baa543f1e05862d), [`1e1263c`](https://github.com/eyelock/ynm/commit/1e1263c9295cdf31009d4f1745f9794c6248cdda)]:
  - @ynm/models@0.4.1
  - @ynm/service@0.4.1
  - @ynm/model@0.3.1
  - @ynm/mcp@0.4.1
  - @ynm/index@0.3.2
  - @ynm/store@0.4.1
  - @ynm/wiki@0.3.2

## 0.4.0

### Minor Changes

- [#63](https://github.com/eyelock/ynm/pull/63) [`1c2a577`](https://github.com/eyelock/ynm/commit/1c2a577f7a2438f64d8fe388edad96d2696a0495) Thanks [@eyelock](https://github.com/eyelock)! - OpenTelemetry. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and ynm sends a span for each HTTP request, MCP
  tool call, CLI command, store call and dream pass, each announced by a `started` event and ended
  with its outcome, plus duration metrics and the server's stderr lines as log records. A request's
  `traceparent` header, a tool call's `_meta`, or `TRACEPARENT` in a command's environment joins the
  caller's trace. Nothing is exported that holds memory content: no bodies, summaries, queries, tool
  arguments, subjects or tags, and namespaces only with `YNM_TELEMETRY_NAMESPACES=1`; every string
  passes through the redaction patterns first. `YNM_AUDIT={"sink":"otel"}` sends audit events to the
  collector, naming the person by their sign-in id and identity provider host. Without an endpoint
  nothing is loaded and nothing changes. `ynm telemetry registry --format json` prints every name ynm
  emits.

- [#66](https://github.com/eyelock/ynm/pull/66) [`e00db04`](https://github.com/eyelock/ynm/commit/e00db04fff915b30899f688517820b5376e04397) Thanks [@eyelock](https://github.com/eyelock)! - Telemetry passes the trace on and names people by login name. With telemetry on, every process
  ynm starts (git, the Claude CLI, the agent CLIs `ynm client install` runs) gets `TRACEPARENT` and
  `TRACESTATE` for the span it runs in, and every request to a hosted ynm through a remote mount
  carries the W3C `traceparent` and `tracestate` headers, so the work ynm calls joins its trace. No
  request to a third party, such as an identity provider or a model API, carries trace context. A
  tool call to a hosted ynm and a call to a model are now client spans of their own
  (`tools/call …`, `model …`), with `started` events and duration metrics. With telemetry off
  nothing changes. The `otel` audit sink's `user.name` is now the
  person's login name, the token's `preferred_username`, falling back to its subject, qualified by
  the identity provider's host; a value with an `@` is never used. Who a person is in ynm, and what
  the other audit sinks record, is unchanged.

- [#64](https://github.com/eyelock/ynm/pull/64) [`9b38d8f`](https://github.com/eyelock/ynm/commit/9b38d8fd6fe478821446029506eb25323bee8aba) Thanks [@eyelock](https://github.com/eyelock)! - Telemetry to a ynr spool. With no OTLP endpoint set, ynm writes its spans, events and metrics as
  OTLP JSON lines into the folder `YNR_SPOOL` names, or into ynr's laptop spool,
  `~/.local/state/ynr/spool/local` (under `XDG_STATE_HOME` when set), when that folder exists. An
  endpoint still wins. Each command, stdio session and function invocation puts its file on disk
  as it ends, within 2 seconds; files are capped, and what is dropped is counted in
  `ynm.telemetry.spool.dropped` and `ynm.telemetry.spool.errors`. A server started before the spool
  exists looks for it once a minute. A hosted server writes to the spool's `services/ynm` folder
  when its deployment sets `YNR_SPOOL` to it. With neither an endpoint nor a spool, nothing is
  loaded and nothing changes.

- [#75](https://github.com/eyelock/ynm/pull/75) [`1a3bd91`](https://github.com/eyelock/ynm/commit/1a3bd919f462cfe1492bd9e712c58972116f59fd) Thanks [@eyelock](https://github.com/eyelock)! - `ynm client install ynh` now writes ynh's `.agents/harness/plugin.json` layout, and the ynm harness
  under `integrations/ynh` uses it too. A harness that still has its manifest in the deprecated
  `.ynh-plugin/` directory is recognised by `ynm client status` and `ynm doctor`, and
  `ynm client install ynh` moves it to `.agents/harness/` (saying so in its output) before merging
  ynm into it, so a harness never ends up with two manifests.

### Patch Changes

- [#76](https://github.com/eyelock/ynm/pull/76) [`30f1650`](https://github.com/eyelock/ynm/commit/30f1650fe234ffa4e76da8fdb19f54befa9c47a2) Thanks [@eyelock](https://github.com/eyelock)! - The Docker image is smaller and contains only the runtime: one bundled `ynm.mjs`, Node, git and
  tini, with no sources, tests, build cache or dev dependencies (770 MB to about 280 MB). It runs as
  a non-root user, uid 1001, and starts the server with `ynm serve --http`. A bind-mounted `/data`
  must be writable by uid 1001 (`chown 1001:1001`); a named volume needs nothing.

- [#69](https://github.com/eyelock/ynm/pull/69) [`1cd6046`](https://github.com/eyelock/ynm/commit/1cd604621735f4a8c7e28a6a79e5258a5bcb932a) Thanks [@eyelock](https://github.com/eyelock)! - `ynm telemetry registry --format json` now prints the same shape as the other YN tools: the tool
  and version, the semantic-conventions release, then the attributes, standard attributes, spans,
  events and metrics. The names themselves are unchanged.
- Updated dependencies [[`1c2a577`](https://github.com/eyelock/ynm/commit/1c2a577f7a2438f64d8fe388edad96d2696a0495), [`e00db04`](https://github.com/eyelock/ynm/commit/e00db04fff915b30899f688517820b5376e04397), [`9b38d8f`](https://github.com/eyelock/ynm/commit/9b38d8fd6fe478821446029506eb25323bee8aba), [`f97228e`](https://github.com/eyelock/ynm/commit/f97228e80af5d923d538caff445bc757087a711b), [`1cd6046`](https://github.com/eyelock/ynm/commit/1cd604621735f4a8c7e28a6a79e5258a5bcb932a), [`1a3bd91`](https://github.com/eyelock/ynm/commit/1a3bd919f462cfe1492bd9e712c58972116f59fd)]:
  - @ynm/mcp@0.4.0
  - @ynm/service@0.4.0
  - @ynm/telemetry@0.4.0
  - @ynm/models@0.4.0
  - @ynm/store@0.4.0
  - @ynm/index@0.3.1
  - @ynm/wiki@0.3.1

## 0.3.0

### Minor Changes

- Occurrences, structured recall and clearer identities. A memory tagged `occurrence` records one
  event where repetition is the signal: dream never merges or supersedes it, still reflects on it,
  and keeps it out of the session-start context; after `dream.occurrenceRetention` (default 90
  days, `null` to keep them) dream retires old occurrences, except those the newest reflection on
  their subject was written from (a reflection now links only the episodes it was written from).
  Recall hits carry a memory's `data`, `dataSchema` and `source`. On a hosted store, a write made
  with a static token is recorded as `token:static` and one from an identity-provider token with no
  subject as `client:<id>`, never as the server's own user. The hosted function logs one line per
  request (method, path, status, duration, MCP method and tool, auth kind), answers before API
  Gateway's 30 seconds run out even after a slow cold start, and its alarms page on a sustained
  error rate rather than a single burst. The release binaries for macOS build on macos-26.

### Patch Changes

- Updated dependencies []:
  - @ynm/index@0.3.0
  - @ynm/mcp@0.3.0
  - @ynm/model@0.3.0
  - @ynm/models@0.3.0
  - @ynm/service@0.3.0
  - @ynm/store@0.3.0
  - @ynm/wiki@0.3.0

## 0.2.0

### Minor Changes

- Hosted and team memory. A hosted ynm runs as an HTTP server or an AWS Lambda over an s3 record
  log, with sign-in through an identity provider (Auth0 on AWS, a local Keycloak to develop
  against). Hosted stores know who wrote what: person ids, nicknames, linked logins and a
  metadata-only audit log. Memory is personal by default, and a hosted store keeps a new memory
  only when sharing is chosen. A local ynm can mount a hosted ynm over MCP, so one ynm holds
  personal memory and the team's store; status and recall say why a store was left out. Hosted
  guidance lets URL-only clients remember intents. Agent integrations live under `integrations/`
  with one client-neutral `ynm-memory` skill. Distributed memory lives at
  `refs/notes/ynm/distributed`. Fixes: dream judges only what changed since the last run and calls
  no model when nothing has; `ynm import` reads piped stdin; `init` says what to commit and `sync`
  sets up fetching for a remote added later; the spend guard charges the estimate when a provider
  omits input tokens; the wiki orphan-branch target keeps deeply nested pages; an empty context
  says "no memory yet" instead of a bare heading.

### Patch Changes

- Updated dependencies []:
  - @ynm/index@0.2.0
  - @ynm/mcp@0.2.0
  - @ynm/model@0.2.0
  - @ynm/models@0.2.0
  - @ynm/service@0.2.0
  - @ynm/store@0.2.0
  - @ynm/wiki@0.2.0

## 0.1.1

### Patch Changes

- Standalone single-executable binaries and a slim bundle replace the Node-dependent tarball;
  two Homebrew formulae (`ynm`, `ynm-slim`); `make` is the developer front door; fixes from the
  documentation pass: `git push` exits 0 after the hook syncs, wiki ingest re-derives summaries,
  working memory defaults its TTL, sync without a remote reports it, input validation exits 2,
  descriptions and defaults everywhere; `ynm client status` detects ynh.
- Updated dependencies []:
  - @ynm/mcp@0.1.1
  - @ynm/service@0.1.1
  - @ynm/store@0.1.1
  - @ynm/index@0.1.1
  - @ynm/model@0.1.1
  - @ynm/models@0.1.1
  - @ynm/wiki@0.1.1
