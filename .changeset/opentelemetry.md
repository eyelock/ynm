---
"@ynm/cli": minor
"@ynm/mcp": minor
"@ynm/service": minor
"@ynm/telemetry": minor
---

OpenTelemetry. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and ynm sends a span for each HTTP request, MCP
tool call, CLI command, store call and dream pass, each announced by a `started` event and ended
with its outcome, plus duration metrics and the server's stderr lines as log records. A request's
`traceparent` header, a tool call's `_meta`, or `TRACEPARENT` in a command's environment joins the
caller's trace. Nothing is exported that holds memory content: no bodies, summaries, queries, tool
arguments, subjects or tags, and namespaces only with `YNM_TELEMETRY_NAMESPACES=1`; every string
passes through the redaction patterns first. `YNM_AUDIT={"sink":"otel"}` sends audit events to the
collector, naming the person by their sign-in id and identity provider host. Without an endpoint
nothing is loaded and nothing changes. `ynm telemetry registry --format json` prints every name ynm
emits.
