# @ynm/telemetry

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
