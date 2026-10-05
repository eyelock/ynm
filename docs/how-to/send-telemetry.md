# Send telemetry to an OpenTelemetry collector

Goal: see what ynm does, and how long it takes, in your own tracing and metrics backend. ynm
speaks OpenTelemetry (OTLP over HTTP) and describes its own work: requests, tool calls, commands,
store calls and dream passes. It never sends memory content.

Telemetry is off until you name an endpoint. With it off, ynm loads none of the OpenTelemetry
SDK, so commands, hooks and servers start and run exactly as they would without it.

## Turn it on

Set the standard OpenTelemetry endpoint variable wherever ynm runs: a shell, a client's MCP
server settings, the container or the function's environment.

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
ynm recall --text "release gate"
```

Every `ynm` command, `ynm serve` over stdio, `ynm serve --http`, the Docker image and the Lambda
function read it. To try it with a local backend that shows traces, run Jaeger, which takes OTLP
on port 4318 and serves its UI on port 16686:

```bash
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:latest
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_LOGS_EXPORTER=none OTEL_METRICS_EXPORTER=none
ynm status
```

Jaeger keeps traces only, so the last export line turns logs and metrics off. Open
`http://localhost:16686` and pick the `ynm` service. For all three signals, point the endpoint at
an OpenTelemetry Collector instead.

For an agent client that launches ynm over stdio, put the variable in that server's environment,
for example `claude mcp add ynm -e OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 -- ynm serve`.

## What ynm sends

| Unit of work | Span | Started event | Metric |
|---|---|---|---|
| An HTTP request to `ynm serve --http` or the function | `POST /mcp` (server) | `ynm.request.started` | `ynm.http.request.duration` |
| An MCP tool call | `tools/call memory_recall` (server) | `ynm.tool.started` | `ynm.tool.call.duration` |
| A CLI command | `ynm recall` | `ynm.command.started` | `ynm.command.duration` |
| A call to a record store | `store append`, `store scan`, … (client) | `ynm.store.started` | `ynm.store.operation.duration` |
| A dream run, and each of its passes | `dream`, `dream dedupe`, … | `ynm.dream.started`, `ynm.dream.pass.started` | `ynm.dream.pass.duration` |

Each unit sends a `started` event as it begins and its span when it ends, so a crash shows as a
start with no finish. Every span ends with `ynm.outcome` (`ok`, `error` or `refused`) and its
status set from it; a failure adds `error.type`, the error's class name. A server also forwards
its own stderr lines (the one-line request log and the `[ynm-mcp …]` messages) as log records,
and prints them exactly as before. `ynm hook` sends nothing: it runs on every turn of an agent
session and stays as fast as it was.

Every record carries `service.name` `ynm`, `service.version` and a `service.instance.id` per
process. `OTEL_RESOURCE_ATTRIBUTES` adds to them or overrides them, for example
`OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=staging`.

`ynm telemetry registry --format json` prints every attribute, event, span and metric with its
meaning, pinned to the OpenTelemetry semantic-conventions release it follows. A collector can tell
which list applies from `service.name` and `service.version`.

## What it never sends

No memory content of any kind: no record bodies or summaries, no query text, no tool arguments,
no subjects or tags. Spans and events carry ids, counts, sizes, tool names, durations and
outcomes. String values pass through the same redaction patterns that guard distributed writes,
yours as well as the [defaults](../reference/configuration.md#default-redaction-patterns), before
they leave the process.

Namespaces can name a person (`user/<person id>`), so they are left out. Set
`YNM_TELEMETRY_NAMESPACES=1` to add the namespace a store call was limited to, as
`ynm.namespace`; it is never put on a metric.

Telemetry is never written into memory. The store holds the same records with telemetry on as
with it off.

## Join a caller's trace

ynm joins the trace it is given, so its spans appear inside the work that called it:

- A command, or `ynm serve` over stdio, reads `TRACEPARENT` and `TRACESTATE` from its environment.
- `ynm serve --http` and the function read the W3C `traceparent` and `tracestate` request headers.
- A tool call also reads `traceparent` and `tracestate` from the MCP request's `_meta`, which is
  how a client passes trace context over stdio.

With none of these, each request or command starts a trace of its own.

## Send audit events too

A hosted server's audit events can go to the collector instead of stdout, a file or S3: set
`YNM_AUDIT` to `{"sink":"otel"}` (see [Audit](operate-a-hosted-store.md#audit)). Each becomes a
`ynm.audit.request` event holding the same metadata, after the redaction patterns run. The person
appears by their handle: their sign-in id, the token's subject, qualified by the identity
provider's host, such as `idp.example.com/alice`, in `user.name`. Never their name or email; a
subject that is an email address is left out. The `otel` sink needs telemetry on, and audit stays
off, with a message on stderr, if it is not.

## Settings

ynm honours the standard OpenTelemetry variables:

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Turns telemetry on and sends every signal to `<endpoint>/v1/traces`, `/v1/logs` and `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `…_LOGS_ENDPOINT`, `…_METRICS_ENDPOINT` | One signal's full URL; set alone, it turns on that signal only |
| `OTEL_EXPORTER_OTLP_PROTOCOL` (and per signal) | `http/protobuf` (default) or `http/json`. `grpc` is not supported: with only `grpc` asked for, telemetry stays off and says so on stderr |
| `OTEL_EXPORTER_OTLP_HEADERS` (and per signal) | Headers sent with each export, such as an API key for a hosted backend |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | How long one export may take, retries included. Default 10 seconds; a command and a stdio server use at most 2 |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER` | `none` turns that signal off |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds between metric exports in a long-running server. Default 60000 |
| `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME` | Resource attributes, which win over ynm's own |
| `OTEL_SDK_DISABLED` | `true` turns telemetry off whatever else is set |
| `TRACEPARENT`, `TRACESTATE` | The trace a command or stdio server joins |

These and `YNM_TELEMETRY_NAMESPACES` are also in the
[configuration reference](../reference/configuration.md#telemetry).

## It never gets in the way

Spans and logs are sent in batches about once a second, from the background. A command that has
finished waits for its last batch for at most 2 seconds, even when the collector is down, and its
output and exit code are the same as without telemetry. A function sends what an invocation
buffered before it returns, within what is left of its time and never more than 2 seconds. Exports
that fail are dropped and counted in the `ynm.telemetry.export.failures` metric; they are never
retried past their timeout or reported as errors.

## Turn it off

Unset `OTEL_EXPORTER_OTLP_ENDPOINT` (and any per-signal endpoint), or set `OTEL_SDK_DISABLED=true`.
