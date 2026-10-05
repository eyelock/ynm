---
"@ynm/cli": minor
"@ynm/mcp": minor
"@ynm/models": minor
"@ynm/service": minor
"@ynm/store": minor
"@ynm/telemetry": minor
---

Telemetry passes the trace on and names people by login name. With telemetry on, every process
ynm starts (git, the Claude CLI, the agent CLIs `ynm client install` runs) gets `TRACEPARENT` and
`TRACESTATE` for the span it runs in, and every request to a hosted ynm through a remote mount, to
an identity provider or to a model API carries the W3C `traceparent` and `tracestate` headers, so
the work ynm calls joins its trace. A tool call to a hosted ynm and a call to a model are now
client spans of their own (`tools/call …`, `model …`), with `started` events and duration
metrics. With telemetry off nothing changes. The `otel` audit sink's `user.name` is now the
person's login name, the token's `preferred_username`, falling back to its subject, qualified by
the identity provider's host; a value with an `@` is never used. Who a person is in ynm, and what
the other audit sinks record, is unchanged.
