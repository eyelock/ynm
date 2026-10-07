# Architecture Decision Records

These ADRs were **drafts and malleable** for the whole build and were consolidated at v0.1.0
(2026-09-29). Lifecycle:

1. **Draft** (now): each file is edited in place as a decision changes. No supersession chain.
   Defaults chosen without strong evidence are marked `(default, <date>)` in Decided.
2. **Build**: as the system is built, dated notes go into each ADR's **Addenda** section rather
   than rewriting the Decision, so the trail of what was learned stays visible.
3. **Consolidate** (done): close to a working product, each ADR's Decision was rewritten to
   absorb its addenda, and the status moved to `accepted`. From then on changes get a new ADR.

Each ADR has: Status, Context, Decision, Alternatives, Consequences, Open questions, History (one
line per addendum that was folded in), and the FR/NFR ids from ADR-000 it satisfies.

| ADR | Decision |
|---|---|
| [000](000-requirements.md) | Functional and non-functional requirements cited by the other ADRs |
| [001](001-memory-model.md) | Memory types, levels and namespaces |
| [002](002-record-format.md) | Append-only record format, identity, supersession, time |
| [003](003-git-notes-layout.md) | Refs, anchors, sharding, writes, merging |
| [004](004-store-abstraction.md) | Record store interface and providers |
| [005](005-search-plugins.md) | Index and ranking plug-in seam |
| [006](006-consolidation-lifecycle.md) | Ingest, consolidate, decay, forget |
| [007](007-personal-vs-distributed.md) | Privacy boundary and sync |
| [008](008-interface-surface.md) | MCP tools, resources, prompts, CLI parity |
| [009](009-hosting-and-bootstrap.md) | Hosting topologies and `ynm init` |
| [010](010-wiki-projection.md) | Compiled markdown wiki as a derived view |
| [011](011-reuse-from-prior-projects-and-mcp-toolkit.md) | What is copied from the old repos |
| [012](012-model-seams-judge-and-writer.md) | Judge (decision models, Jev) and Writer (generative, structured output) seams |
| [013](013-client-integrations.md) | Client integration adapters: Claude Code, Copilot CLI, OpenCode, Pi, ynh |
| [014](014-evals-and-benchmarks.md) | Evals and benchmarks tracked at all times |
| [015](015-distribution.md) | Distribution: standalone binaries, a slim bundle and the image |
| [016](016-agent-guidance-delivery.md) | Agent guidance delivery: `ynm hook` subcommands, and `ynm init` configures every detected client |
| [017](017-auth-identity-audit.md) | Authentication, identity and audit for the HTTP server: an `AuthProvider` seam (local token, OIDC with provider presets, introspection), never open by default, per-user provenance and an audit log (proposed) |
| [018](018-opentelemetry.md) | OpenTelemetry over OTLP: loaded only when an endpoint is set, spans at the boundaries joining the caller's trace, an `otel` audit sink naming people by handle, no content, a Weaver-style registry (proposed) |
