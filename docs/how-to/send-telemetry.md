# Send telemetry to an OpenTelemetry collector

Goal: see what ynm does, and how long it takes, in your own tracing and metrics backend. ynm
speaks OpenTelemetry (OTLP over HTTP, or OTLP JSON lines into a [ynr](#write-to-a-ynr-spool)
spool folder) and describes its own work: requests, tool calls, commands, store calls and dream
passes, and its calls to a hosted ynm and to models. It never sends memory content.

Telemetry is off until you name an endpoint or a ynr spool is found. With it off, ynm loads none
of the OpenTelemetry SDK, so commands, hooks and servers start and run exactly as they would
without it.

ynm picks where to write once, as it starts, in this order:

1. `OTEL_EXPORTER_OTLP_ENDPOINT` (or a per-signal endpoint) is set: it sends there.
2. Otherwise, `YNR_SPOOL` names a folder, or ynr's laptop spool,
   `$XDG_STATE_HOME/ynr/spool/local` (`~/.local/state/ynr/spool/local` by default), exists: it
   writes there.
3. Otherwise: nothing.

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

## Write to a ynr spool

ynr collects the telemetry of the YN* tools from a spool: a folder where each tool writes OTLP
JSON lines, one export per line, and `ynr serve` reads them and ships them on. Writing to disk
instead of a network endpoint means a batch already written survives ynm being killed, and there
is no endpoint to reach.

On a laptop there is nothing to set. Once `ynr serve` has created its spool, every `ynm` command
and server finds `~/.local/state/ynr/spool/local` and writes there:

```bash
ynm status
ls ~/.local/state/ynr/spool/local
```

Each process writes its own files, named `ynm-<instance id>-<n>.jsonl`; the one it is still
writing ends `.open.jsonl` and is renamed when the process exits. ynm only writes to the spool. It
never starts `ynr`.

To write somewhere else, set `YNR_SPOOL` to the folder ynm should write in: the folder for ynm's
own files, not the spool's root. ynm creates it if it does not exist. A tool that runs ynm and
gives it a folder of its own, such as ynf for an agent run, sets it for you.

An `OTEL_EXPORTER_OTLP_ENDPOINT` in the environment wins over the spool: if you have one set
globally for other tooling, ynm sends there and the spool receives nothing from it.

A server, `ynm serve` over stdio or HTTP, that starts before the spool exists looks for it again
once a minute and starts writing when it appears. Work already in progress at that moment has no
spans, and a store the server opened before then has no store spans until it restarts. A command
and the Lambda function decide once, as they start.

### When hosted

A hosted server writes to a spool when its deployment gives it one: set `YNR_SPOOL` to the
`services/ynm` folder under the spool's root, for example
`YNR_SPOOL=/var/lib/ynr/spool/services/ynm`, on a volume that a `ynr serve` beside the server
also reads. Running that `ynr serve` is the deployment's job; ynm never starts it. With no
`YNR_SPOOL` and no endpoint, a hosted server sends nothing, so use an OTLP endpoint if there is no
`ynr` beside it.

## What ynm sends

| Unit of work | Span | Started event | Metric |
|---|---|---|---|
| An HTTP request to `ynm serve --http` or the function | `POST /mcp` (server) | `ynm.request.started` | `ynm.http.request.duration` |
| An MCP tool call | `tools/call memory_recall` (server) | `ynm.tool.started` | `ynm.tool.call.duration` |
| A CLI command | `ynm recall` | `ynm.command.started` | `ynm.command.duration` |
| A call to a record store | `store append`, `store scan`, … (client) | `ynm.store.started` | `ynm.store.operation.duration` |
| A dream run, and each of its passes | `dream`, `dream dedupe`, … | `ynm.dream.started`, `ynm.dream.pass.started` | `ynm.dream.pass.duration` |
| A tool call to a hosted ynm, through a remote mount | `tools/call memory_recall` (client) | `ynm.remote.started` | `ynm.remote.call.duration` |
| A call to a model: the Claude CLI, an OpenAI-compatible endpoint or TypeSafe | `model claude-cli`, `model openai-compatible`, `model typesafe` (client) | `ynm.model.started` | `ynm.model.call.duration` |

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
meaning, in the same shape as the other YN tools: the tool and its version, the
OpenTelemetry semantic-conventions release it follows, ynm's attributes, the standard attributes
it uses by name, then its spans, events and metrics. A collector can tell which list applies from
`service.name` and `service.version`.

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

## Pass the trace on

ynm passes its trace on to what it calls, so work it starts appears inside its spans:

- Every process ynm starts gets `TRACEPARENT`, and `TRACESTATE` when there is one, naming the span
  it runs in. That replaces any `TRACEPARENT` ynm itself was given, so the child nests under ynm's
  span rather than beside it. This covers git, the Claude CLI that writes for dream passes, the
  `claude --version` check, and the agent CLIs that `ynm client install` runs. A git hook that
  runs `ynm`, such as the pre-push hook, joins the same trace.
- Every request to a hosted ynm through a remote mount carries the W3C `traceparent` and
  `tracestate` headers, and each tool call carries them in its MCP `_meta` too, so the hosted
  server's spans join the caller's trace.
- Nothing ynm sends to a third party carries the trace: sign-in for a remote mount (`ynm login`),
  token introspection on a hosted server, a token refresh at your identity provider, and requests
  to an OpenAI-compatible endpoint or TypeSafe are sent exactly as they are with telemetry off.

A tool call to a hosted ynm, and each call to a model, is a client span of its own. A git command
is not: it runs inside the store call's span, `store sync` or `store append`, and is given that
span's trace. The command line of a process ynm starts is never exported.

With telemetry off, nothing changes: a process gets exactly the environment it got before, and a
request carries no trace headers.

## Send audit events too

A hosted server's audit events can go to the collector instead of stdout, a file or S3: set
`YNM_AUDIT` to `{"sink":"otel"}` (see [Audit](operate-a-hosted-store.md#audit)). Each becomes a
`ynm.audit.request` event holding the same metadata, after the redaction patterns run. The person
appears by their handle in `user.name`: their login name at the identity provider, qualified by
its host, such as `idp.example.com/alice`.

- The login name is the token's `preferred_username` (or, from token introspection, `username`).
  Providers such as Keycloak make the token's subject an opaque id, so the login name is what a
  person would recognise.
- A token with no login name falls back to its subject.
- Never a name or an email. A value containing `@` is not used: an email login name falls back to
  the subject, and when the subject is an email too, the event has no `user.name`.

Only the handle reads the login name. Which person a token is, the author recorded on memories,
and the stdout, file and S3 audit events still come from the token's issuer and subject alone, so
a person who changes their login name stays the same person. The `otel` sink needs telemetry on,
and audit stays off, with a message on stderr, if it is not.

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
| `TRACEPARENT`, `TRACESTATE` | The trace a command or stdio server joins. ynm sets them for each process it starts (see [Pass the trace on](#pass-the-trace-on)) |

And ynr's:

| Variable | Effect |
|---|---|
| `YNR_SPOOL` | The folder to write OTLP JSON lines in, when no OTLP endpoint is set. Created if missing |
| `XDG_STATE_HOME` | Where ynr's laptop spool lives: ynm writes to `$XDG_STATE_HOME/ynr/spool/local` when it exists and nothing else is set. Default `~/.local/state` |

These and `YNM_TELEMETRY_NAMESPACES` are also in the
[configuration reference](../reference/configuration.md#telemetry).

## It never gets in the way

Spans and logs are sent in batches about once a second, from the background. A command that has
finished waits for its last batch for at most 2 seconds, even when the collector is down, and its
output and exit code are the same as without telemetry. A function sends what an invocation
buffered before it returns, within what is left of its time and never more than 2 seconds. Exports
that fail are dropped and counted in the `ynm.telemetry.export.failures` metric; they are never
retried past their timeout or reported as errors.

Writing to a spool is the same. Batches are written about once a second, and each command, stdio
session and function invocation flushes its file to disk as it ends, giving up after 2 seconds on
a slow disk. Each process's files are capped (8 MiB a file, 64 MiB in all); past the cap, and when
the folder cannot be written at all, records are dropped and counted in
`ynm.telemetry.spool.dropped` and `ynm.telemetry.spool.errors`, and ynm carries on with its
output and exit code unchanged.

## Turn it off

Unset `OTEL_EXPORTER_OTLP_ENDPOINT` (and any per-signal endpoint) and `YNR_SPOOL`, or set
`OTEL_SDK_DISABLED=true`, which also keeps ynm from writing to a laptop spool.
