# @ynm/mcp

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

### Patch Changes

- Updated dependencies [[`1c2a577`](https://github.com/eyelock/ynm/commit/1c2a577f7a2438f64d8fe388edad96d2696a0495), [`e00db04`](https://github.com/eyelock/ynm/commit/e00db04fff915b30899f688517820b5376e04397), [`9b38d8f`](https://github.com/eyelock/ynm/commit/9b38d8fd6fe478821446029506eb25323bee8aba), [`f97228e`](https://github.com/eyelock/ynm/commit/f97228e80af5d923d538caff445bc757087a711b), [`1cd6046`](https://github.com/eyelock/ynm/commit/1cd604621735f4a8c7e28a6a79e5258a5bcb932a), [`1a3bd91`](https://github.com/eyelock/ynm/commit/1a3bd919f462cfe1492bd9e712c58972116f59fd)]:
  - @ynm/service@0.4.0
  - @ynm/telemetry@0.4.0
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
  - @ynm/model@0.3.0
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
  - @ynm/model@0.2.0
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
  - @ynm/service@0.1.1
  - @ynm/store@0.1.1
  - @ynm/index@0.1.1
  - @ynm/model@0.1.1
  - @ynm/wiki@0.1.1
