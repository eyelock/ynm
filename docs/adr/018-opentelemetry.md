# ADR-018: OpenTelemetry: spans at the boundaries, an otel audit sink, loaded only when on

Status: proposed (2026-10-05)
Satisfies: NFR-5, NFR-10, NFR-11, NFR-12

## Context

ynm logs to stderr (NFR-12): one line per HTTP request from the server and the function, and
`[ynm-mcp …]` messages. That says a request happened. It cannot say where the time went inside it
(the store, the index, a dream pass), and it cannot place ynm's work inside the work that called
it. When ynf runs a step that calls ynm, the step's trace stops at ynm's door.

ynr, the factory's observation plane, defines a contract every YN* tool meets to take part (ynr
ADR-006, with ADR-002 for the telemetry model, ADR-004 for where to write and ADR-007 for
registries). In short: set up the language's official OpenTelemetry SDK once per process; describe
the service; join the trace you were given; announce each unit of work with a `started` event;
span boundaries, not functions; own and publish a registry of your names; keep metric attributes
low-cardinality; bridge the existing logger without changing its output; export no content and
name people only by a host-qualified handle; record the tool's own outcome; never block or fail
because of telemetry. It is optional: every tool must work unchanged without it.

Three constraints are ynm's own:

- **Cost when off.** The slim bundle and the standalone binaries (ADR-015) start in about 0.15 s,
  and `ynm hook` runs on every turn of an agent session (ADR-016). Most users will never turn
  telemetry on, and they should not pay to load an SDK they do not use.
- **Memory is content.** A record's body, its summary, a query's text, a tool's arguments, a
  subject or a tag can each hold anything a user said. Telemetry often outlives and travels further
  than the store, so none of it may leave through telemetry. Namespaces can name a person
  (`user/<person id>`).
- **ynm's own audit stays as it is.** ADR-017's sinks (stdout, file, s3) and their event are
  what operators already read.

ADR-017 anticipated this: "The same seam takes an OpenTelemetry or SIEM sink later."

## Decision

### Where to write, and only when asked

ynm writes over OTLP/HTTP, with the official OpenTelemetry JS SDK configured by the standard
variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, the per-signal endpoints, `_PROTOCOL`, `_HEADERS`,
`_TIMEOUT`, `OTEL_<SIGNAL>_EXPORTER=none`, `OTEL_SDK_DISABLED`), or as OTLP JSON lines into a ynr
spool with ynr's `@eyelock/otel-spool-exporter`. The choice is made once at process start, in one
function (`telemetryTarget` in `@ynm/telemetry`), in the contract's order (ynr ADR-004):

1. An OTLP endpoint is set: export there, for each signal that has an endpoint.
2. Otherwise, `YNR_SPOOL` is set, or the laptop default `$XDG_STATE_HOME/ynr/spool/local`
   (`XDG_STATE_HOME` defaulting to `~/.local/state`; a relative one is ignored) is a folder:
   write every signal not set to `none` to that folder.
3. Otherwise: off.

`telemetryTarget` stays synchronous and costs at most one `stat`, of the laptop default.
`OTEL_SDK_DISABLED=true` turns the spool off too.

**`YNR_SPOOL` names a writer folder, not the spool root.** ynr ADR-004 defines it that way: a tool
writes its own files, `<service>-<instance id>-<seq>.jsonl`, into the one folder it is given, and
the tool that gives a child its own folder (ynf, `runs/<run id>/`) sets `YNR_SPOOL` to it. ynm
does not append a subfolder of its own. The exporter names the files from the resource's
`service.name` and `service.instance.id`, so `OTEL_SERVICE_NAME` renames them as it renames the
service. The folder is created on the first write.

**Hosted.** A hosted ynm writes to the spool's `services/ynm/` folder by the same rule: the
deployment sets `YNR_SPOOL=<spool root>/services/ynm`, on a volume a `ynr serve` beside the server
reads. ynm has no setting for the spool root, and never derives `services/ynm` itself, because
ADR-004's detection order has a single variable for the folder to write in, and a second one that
means a root only on servers would make the same variable mean two things. With no `YNR_SPOOL`, a
hosted server checks the laptop default like any other process; in a container it does not
exist, so telemetry is off unless an endpoint is set.

**Lambda.** A function's only disk is `/tmp`, which is lost with the instance and read by nothing,
so a spool there would be written and never collected. The Lambda's path is OTLP until ynr has a
relay a function can send to; `YNR_SPOOL` works there but is documented as not useful.

`http/protobuf` is the default and `http/json` is supported. `grpc` is not: the gRPC exporters pull
in a gRPC stack the bundles do not need, and with only `grpc` asked for, telemetry stays off with
one line on stderr saying why.

### Lazy loading

All of it lives in a new package, `@ynm/telemetry`, behind a facade (`withSpan`, `beginSpan`,
`emitEvent`, `emitLog`, `traceEnv`, `tracedFetch`, `traceContext`, `flushTelemetry`,
`shutdownTelemetry`) that imports no `@opentelemetry` module. `startTelemetry` loads the SDK with a dynamic `import()` only when the target is not off.
Until then, and in every process where it never is, `withSpan(name, opts, fn)` is `fn(noop)`, and
the store is not wrapped at all (below).

- **The spool exporter loads with the SDK.** `sdk.ts`, the module behind the dynamic import,
  imports `@eyelock/otel-spool-exporter`; nothing else does. With no endpoint and no spool, neither
  loads.
- **Proof, unbundled:** a test runs the built CLI under a Node module hook that records every
  module resolved from an `@opentelemetry` package or the spool exporter: `--version`, `status`,
  `remember`, `recall`, `hook session-start` and `serve` over stdio load none; the same `status`
  with an endpoint set, or `remember` with `YNR_SPOOL` set, loads them, and exit codes and output
  are unchanged.
- **Proof, bundled:** esbuild inlines the SDK and the spool exporter into the slim, standalone and
  Lambda bundles behind lazily initialised wrappers. The bundle scripts read esbuild's metafile
  and fail the build if any `@opentelemetry` or spool-exporter module is reachable from the entry
  without crossing a dynamic import, or if either is missing. The release smoke test runs one
  command with an endpoint set and checks that spans arrive, and one with `YNR_SPOOL` set and
  checks that spans are written. The SDK adds about 0.3 MB to the 2.1 MB minified bundle; `ynm --version`
  still takes about 0.14 s.
- **Process start.** The CLI starts telemetry in `YnmCommand` before a command runs, the server
  entry before it opens the store, and the function at initialisation, with the store waiting for
  it. `ynm hook` never starts it: it runs every turn and must stay fast. `ynm serve` starts its own.
- **The once-a-minute recheck.** `ynm serve`, over stdio or HTTP, starts telemetry with
  `recheck`: when it finds neither an endpoint nor a spool, it sets an unref'd one-minute interval
  that calls `telemetryTarget` again (one `stat`) and starts telemetry when the laptop spool
  appears, then stops. Nothing else runs, and the timer never keeps a process alive. It is not set
  when telemetry is off for a reason (`OTEL_SDK_DISABLED`, `grpc` only), and a command or the
  Lambda function never sets it: they decide once. Spans for work already in flight when telemetry
  starts are absent, and a store the server opened before then stays uninstrumented (the store
  proxy is applied only when telemetry is on at open), so a late start gives request, tool and
  dream spans but no store spans until the server restarts.

### What is a span

One span per unit of ynm's own work, and one per call out to a store. Each emits a
`<unit>.started` event (a log record with an event name, in the span's context) as it begins, and
ends with `ynm.outcome` (`ok`, `error`, `refused`) and its status set from it: `ok` sets OK,
`error` sets ERROR and `error.type` (the error's class name, never its message), `refused` leaves
it unset, as a 4xx is the caller's doing.

| Unit | Span name, kind | Where |
|---|---|---|
| HTTP request | `{method} {route}`, server | `startHttp` and the Lambda handler, around the front door, the MCP handler and the buffered body |
| MCP tool call | `tools/call {tool}`, server, with `mcp.method.name`, `gen_ai.tool.name`, `gen_ai.operation.name` | each registered tool in `server.ts` |
| CLI command | `ynm {command}`, internal | `YnmCommand._run` |
| Store call | `store {append, scan, purge, sync, read_document, write_document}`, client | a proxy over each mount's `RecordLog`, applied in `openMounts` only when telemetry is on |
| Dream run and pass | `dream` and `dream {pass}`, internal | `dream/engine.ts` |
| Tool call to a hosted ynm | `tools/call {tool}`, client, with `mcp.method.name`, `gen_ai.tool.name`, `ynm.mount`, `server.address` | `RemoteStore.call` |
| Model call | `model {provider}`, client, with `ynm.model.provider` (`claude-cli`, `openai-compatible`, `typesafe`) and `gen_ai.request.model` | each attempt of `ValidatingWriter.write`, and `TypeSafeJudge.judge` |

Index queries and ranking are inside these spans and get none of their own. A model call's span
covers one Claude CLI invocation or one HTTP request, so a writer's retry after an answer that
failed validation is a second span.

**A git command gets no span.** git is how the git-notes store does its work, not a system of
its own: a store call already has a client span at that boundary, and one call runs several git
processes (a sync runs a dozen or more, and reads are batched but still more than one), so a span
each would multiply the store's spans without saying anything the store span does not. The
network half of git, a sync's fetch and push, is inside `store sync`. git is still given the store
span's trace context (below), which is what lets a hook it runs, such as ynm's pre-push hook, join
the trace. The other processes ynm starts are not calls to another system either and get no span:
the `claude --version` check before choosing a writer, and the agent CLIs `ynm client install`
runs, which happen inside the command's span.

### Passing the trace on

ynm passes the active span's W3C trace context to the processes it spawns and to our own tools,
which for ynm means a hosted ynm (ynr ADR-006, item 4), computed through the facade. A third party,
such as an identity provider or a model API, is never sent trace context: its request is sent
exactly as it would be without telemetry, though the call is still a client span of ynm's own.

- **Processes.** `traceEnv(env)` returns `env` with `TRACEPARENT`, and `TRACESTATE` or none, set
  to the active span, replacing whatever ynm itself inherited, because the child belongs under
  ynm's span, not beside it. It is used for every process ynm spawns: git (`@ynm/store`'s one
  runner, so the service's git calls too), the Claude CLI (in `claudeCliEnv`), the `claude
  --version` check, and `ynm client install`'s CLIs. With telemetry off, or outside any span, it
  returns `env` itself, so a child inherits exactly what it did before, including a `TRACEPARENT`
  ynm was given.
- **HTTP.** `tracedFetch(origin, f)` wraps a fetch so each request to `origin` carries
  `traceparent` and `tracestate` for the span it is sent in, decided per request, and passes its
  arguments through untouched when there is nothing to add or the request goes anywhere else. It
  wraps only the remote mount's MCP transport, with the hosted ynm's origin, so a token refresh
  the transport makes at an identity provider carries nothing. The remote sign-in (`ynm login`),
  token introspection, the OpenAI-compatible writer and the TypeSafe judge send no trace headers.
- **MCP `_meta`.** A remote mount's tool call also carries `traceparent` and `tracestate` in its
  `_meta`, which is where ynm's own server reads them for the tool span, so the hosted tool span
  is a child of the caller's client span rather than of its own HTTP request span.

Not covered: the JWKS fetch inside `jose`, which has no fetch seam and is cached for the process;
the AWS SDK's requests to S3, which S3 does not join and which the store span already times; and
the platform opener `ynm login` starts to show the browser, because a browser it launches would
carry a stale `TRACEPARENT` for its whole life.

Both helpers cost one branch when telemetry is off and import nothing. The command line of a
spawned process is never an attribute: a model CLI's arguments hold the prompt, and git's can
hold refs and paths.

**Joining traces.** An HTTP request's span joins the W3C `traceparent`/`tracestate` headers; a
tool call also reads them from the MCP request's `_meta`, which is how a stdio client passes
them; a process joins `TRACEPARENT`/`TRACESTATE` from its environment. Otherwise a span is a child
of the active span, or a new trace.

**Resource.** `service.name=ynm`, `service.version` from the compiled version module (the same
value as `ynm-mcp --version`), and a random `service.instance.id` per process.
`OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME` win over these.

**Metrics** are durations of the units above, on histograms whose attributes are only those the
registry declares for them (tool name, method, route, status code, store operation and provider,
dream pass, outcome), and a counter of failed exports. A span's attributes reach a metric only
through that list, so a mount, namespace, memory id or trace id cannot. Each metric's declared
cardinality limit is set on the SDK as a view.

### No content

The facade is the one way out, and it enforces the rules:

- Callers pass ids, counts, sizes, names, durations and outcomes. No caller passes a record body,
  summary, query, tool argument, subject or tag; tests below fail if one does.
- Every string value, in attributes and log bodies, passes through the redaction patterns
  (`DEFAULT_REDACTION` plus the store's configured ones, added when a store opens) and is capped
  at 256 characters. A bridged stderr line also has its double-quoted strings masked, because an
  error can quote what it failed to parse.
- `ynm.namespace` is dropped unless `YNM_TELEMETRY_NAMESPACES=1`, and is never on a metric.
- Telemetry is never written into memory and nothing acts on it.

A test drives a function with telemetry exported to memory: it remembers, recalls, reads context
and consolidates with a canary string in the content, summary, subject, tags, namespace and query,
and asserts the canary is in the store but nowhere in the exported spans, events, logs or metrics,
and that the store holds the same records as the same run with telemetry off.

### The `otel` audit sink and people by handle

`YNM_AUDIT={"sink":"otel"}` adds a fourth sink beside ADR-017's. Each audit event becomes one
`ynm.audit.request` event with the same metadata (id, method, path, status, outcome, refusal
reason, tool names, call and error counts, memory ids, input bytes, result count, duration), after
redaction. It needs telemetry on; otherwise the sink is refused at start and audit stays off with a
message, as for any bad setting.

The person appears as a **handle** in `user.name`: their login name at the identity provider,
qualified by the issuer's host, `idp.example.com/alice`. The login name is the token's
`preferred_username` (from introspection, `preferred_username` or else RFC 7662's `username`),
because a provider such as Keycloak makes `sub` an opaque id that no one would recognise on a
dashboard or match to another tool's events. The rules:

- `preferred_username`, when the token carries one and it has no `@`;
- else `sub`, when it has no `@`;
- else no handle. A handle is never a name or an email, so an email login name falls back to the
  subject, and when both are emails the event has no `user.name`.

Only a signed-in person has a handle: a token with no `sub` has none, whatever name it carries.
The verifiers carry the claim beside `iss` and `sub` in the request's auth info, and `handleOf`
is its only reader. **ynm's own identity is unchanged:** the person id, the actor and provenance
on records, `ynm people`, and the stdout, file and s3 audit sinks read `iss` and `sub` alone, as
ADR-017 decides. A person whose login name changes keeps their person id; only the handle in
telemetry follows the new name.

The ynm person id (`p…`) is not exported: it is ynm's own key, and the contract names
people in the system where they acted. `ynm.actor.kind` is `human` for a signed-in person and `bot`
for a shared static token or a client acting with no subject.

The handle travels beside the event (`AuditSink.write(event, { handle })`), never in it, so the
stdout, file and s3 sinks write exactly what ADR-017 defines.

### The logger bridge

When telemetry is on in a server, `console.error`, `console.warn` and `console.info` lines that
begin `[ynm-mcp` or `ynm-mcp ` (the request log and the server's messages) are also emitted as log
records at the matching severity. The console call itself is unchanged, so stderr is byte-for-byte
what it was. Nothing else is bridged: a CLI's stdout carries memory content and is never read.

### The registry

`telemetry/registry/` holds ynm's names in OpenTelemetry Weaver's format: every `ynm.*`
attribute, the events, the spans, the metrics with their attributes' cardinalities and limits, and
a manifest pinning semantic conventions v1.43.0 (the `@opentelemetry/semantic-conventions`
release installed). Weaver is not installed, so `scripts/gen-telemetry.mjs`, run by `make gen`,
checks it (every own name under `ynm.`, every `ref` known to ynm or the pinned release, which must
match the installed one, every metric's attributes within its limit) and generates
`packages/telemetry/src/registry.gen.ts`: constants for every name and the registry as data. A
test fails when the generated file is stale. `ynm telemetry registry --format json` prints
`{ tool, version, semantic_conventions, attributes, standard_attributes, spans, events, metrics }`,
the shape ynf prints so ynr can read every tool's registry; `service.name` and `service.version`
say which registry applies.

### Never block, never fail

- Spans and logs go through batch processors that write at least once a second; metrics through a
  periodic reader (60 s by default, `OTEL_METRIC_EXPORT_INTERVAL`).
- Every exporter is wrapped: a failed or throwing export is counted in
  `ynm.telemetry.export.failures` and swallowed. The SDK's diagnostics stay silent.
- The spool writer never reports a failure to the SDK. Each line is one synchronous append, so a
  batch written survives the process dying; its files are capped (8 MiB a file, 64 MiB a writer);
  what it drops and the filesystem operations that fail or time out are counted in
  `ynm.telemetry.spool.dropped` and `ynm.telemetry.spool.errors`, two registry metrics beside
  the export failures, observed from the writer's `stats()`.
- **Flushing to disk.** `flushTelemetry` forces the providers to export and then calls the
  writer's `sync()`, which puts the open file on disk (ynr ADR-004's per-unit-of-work flush);
  `shutdownTelemetry` shuts the providers down and then calls `close()`, which syncs and renames
  the file to `.jsonl`. Both stay inside the facade's 2-second bound, and the writer's own flush
  is bounded by the same time (`syncTimeoutMs`), so a slow network filesystem cannot hold a process.
  A command and a stdio session (on stdin closing) shut down; a Lambda invocation flushes. An
  HTTP server syncs only as it shuts down: between, batches are written once a second and survive
  the process dying, but not the host.
- A command flushes on exit for at most 2 seconds, and its exports, retries included, are capped
  at 2 seconds, so a collector that is down cannot hold the process open longer than that. A
  stdio server does the same when its client closes stdin. Output and exit codes are unchanged.
- The function flushes before each invocation returns, bounded by the response budget left
  (`responseBudget`) and never over 2 seconds, so a slow collector cannot make a request late.
- A failure to start telemetry is one line on stderr, and telemetry stays off.

## Alternatives considered

- **`@opentelemetry/sdk-node`.** One call sets everything up, but it brings every exporter
  (gRPC, Zipkin, Prometheus) and auto-instrumentation into the bundle. Composing the trace, logs
  and metrics SDKs with the HTTP exporters keeps the addition to about 0.3 MB.
- **Static imports of `@opentelemetry/api` with no SDK registered.** The API is small and its
  no-op tracer is cheap, but it is still modules loaded on every start and every hook, which the
  contract and ADR-015's start-up budget ask us to avoid. The facade costs one branch.
- **A separate optional download for the SDK.** Keeps the bundle at its old size, but turning
  telemetry on would need a second install, and the standalone binary has nowhere to put it.
- **The subject alone as the handle.** It is what ADR-017 reads, and stable, but with Keycloak
  and similar providers it is a UUID, so a dashboard would show ids no one recognises and could
  not join ynm's events to other tools', which name people by login name.
- **A span per git command.** Simple to add at the one runner, but a store call runs several, so
  traces would fill with short spans that repeat what the store span says; the trace context
  passed to git is what a child that reports telemetry needs.
- **The person id as the handle.** Stable across identity providers and already pseudonymous,
  but the contract names people in the system where they acted, so a dashboard can join ynm's
  events to the identity provider's and to other tools'.
- **Auto-instrumentation of `http`.** Spans for every outbound call, including the exporter's own;
  the boundaries that matter are few and known.

## Consequences

- Operators get traces of hosted requests that join the caller's trace, with store and dream time
  broken out, and durations by tool and outcome, from any OpenTelemetry backend.
- The bundles grow by about 0.3 MB minified; nothing loads unless an endpoint is set.
- Adding a name means editing the registry and running `make gen`; a stale constants file fails
  the tests.
- A store opened before telemetry starts is not instrumented, so every entry point starts
  telemetry before opening a store.
- With an endpoint set, a command that finishes while the collector is down exits up to 2 seconds
  later than it would have.
- `@eyelock/otel-spool-exporter` is public on GitHub's npm registry, which still needs a token
  even to read. The project `.npmrc` names only the registry; contributors keep a token with
  `read:packages` in their own `~/.npmrc`, CI and release jobs write a line reading the
  workflow's own `GITHUB_TOKEN` (with `packages: read`) into the runner's, and the Docker build
  does the same inside a BuildKit secret mount. Users never need it: every release artefact
  inlines the exporter.
- On a laptop where `ynr serve` has made its spool, every ynm command and server writes telemetry
  with nothing set; `OTEL_SDK_DISABLED=true` stops it.

## Open questions

- **Hosted wiring.** Running a `ynr serve` beside the server, configured by the deployment (the
  Docker image, the compose demo, the Terraform). ynm already writes to `services/ynm/` when
  `YNR_SPOOL` says so.
- **A relay for the Lambda.** A function's spool is lost with its instance; until ynr has a relay
  a function can send to, the function's telemetry goes over OTLP.
- **Conformance.** `.ynr/conformance.yaml` scenarios and `ynr conformance` as a required CI check.
  The canary and store-unchanged test above is the in-repo version of the check the scenarios
  will run.

## History

- 2026-10-05: proposed for eyelock/ynm#62, on the OTLP path only; the spool, hosted wiring and
  conformance are deferred.
- 2026-10-05: the ynr spool is decided: `YNR_SPOOL` or the laptop default after the OTLP endpoint,
  written with `@eyelock/otel-spool-exporter` 0.1.0, the once-a-minute recheck for servers, the
  spool's dropped and error counts, and hosted ynm writing to `services/ynm/` through `YNR_SPOOL`.
  Running `ynr serve` beside a deployment, the Lambda relay and conformance stay open.
- 2026-10-05: calls out and the handle are decided. ynm passes the active span's trace context to
  every process it spawns (`TRACEPARENT`, `TRACESTATE`) and on every HTTP request it makes to a
  hosted ynm, an identity provider or a model API (the W3C headers, and the MCP `_meta` for a
  remote mount's tool calls), through the facade's `traceEnv` and `tracedFetch`, which change
  nothing when telemetry is off. A tool call to a hosted ynm and a model call are client spans
  with their own events and metrics; a git command is not, the store call being the boundary.
  The handle reads `preferred_username`, falling back to `sub`, never a value with an `@`; ynm's
  own identity still reads only `iss` and `sub`. Still proposed.
- 2026-10-05: trace context goes only to processes ynm spawns and to our own tools, following the
  refined ynr ADR-006 item 4. Requests to a hosted ynm keep the W3C headers and `_meta`; requests
  to an identity provider or a model API carry none, while their client spans stay. Still
  proposed.
- 2026-10-06: the registry's JSON output follows the shared shape ynf uses, so ynr can read it.
  Names are unchanged. Still proposed.
- 2026-10-07: the spool exporter package is public; CI reads it with the workflow's own token and
  the YNR_READ_PACKAGES secret is gone. Still proposed.
