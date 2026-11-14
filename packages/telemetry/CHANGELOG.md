# @ynm/telemetry

## 0.4.2

### Patch Changes

- [#153](https://github.com/eyelock/ynm/pull/153) [`e62daea`](https://github.com/eyelock/ynm/commit/e62daea84b883dc838c6bac432a7ab5044b96326) Thanks [@eyelock](https://github.com/eyelock)! - Every ynm span has a fixed name equal to its `started` event's unit, as ynr conformance rule 5 needs (ynm [#151](https://github.com/eyelock/ynm/issues/151)): `ynm.request`, `ynm.tool`, `ynm.remote`, `ynm.model`, `ynm.dream` and `ynm.dream.pass`, joining `ynm.command` and `ynm.store`. The variable part (HTTP method and route, tool, model provider, dream pass) is in the attributes it already had. Dashboards and queries that match the old names (`POST /mcp`, `tools/call memory_recall`, `model claude-cli`, `dream`, `dream dedupe`) must match the new names and filter on those attributes.

- [#149](https://github.com/eyelock/ynm/pull/149) [`fd58ba0`](https://github.com/eyelock/ynm/commit/fd58ba0ca512f2e632672e73b8abe5119d13415e) Thanks [@eyelock](https://github.com/eyelock)! - `ynr conformance` passes against ynm and runs in CI (ynm [#131](https://github.com/eyelock/ynm/issues/131)). The telemetry registry's manifest is `telemetry/registry/manifest.yaml`, as in ynr, ynh and ynf, and the CLI command and store-call spans are named `ynm.command` and `ynm.store` (the command and the call are the `ynm.command.name` and `ynm.store.operation` attributes), so each matches its `started` event.

## 0.4.1

### Patch Changes

- [#102](https://github.com/eyelock/ynm/pull/102) [`7be4f27`](https://github.com/eyelock/ynm/commit/7be4f275cdb6d0c2189f1b7cdcdb54415899886e) Thanks [@eyelock](https://github.com/eyelock)! - Telemetry runs on OpenTelemetry 3: the API at 1.10, the SDK at 3.0, the OTLP exporters at 0.300, and the ynr spool exporter at 0.3.0. The logs API now comes from `@opentelemetry/api`, so `@opentelemetry/api-logs` is gone. What ynm sends, and where, is unchanged.

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

- [#69](https://github.com/eyelock/ynm/pull/69) [`1cd6046`](https://github.com/eyelock/ynm/commit/1cd604621735f4a8c7e28a6a79e5258a5bcb932a) Thanks [@eyelock](https://github.com/eyelock)! - `ynm telemetry registry --format json` now prints the same shape as the other YN tools: the tool
  and version, the semantic-conventions release, then the attributes, standard attributes, spans,
  events and metrics. The names themselves are unchanged.
