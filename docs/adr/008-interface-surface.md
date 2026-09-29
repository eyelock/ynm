# ADR-008: MCP tools, resources, prompts and CLI parity

Status: draft
Satisfies: FR-7, FR-8, FR-9, FR-14, NFR-9, NFR-11

## Context

ACME exposed 38 tools and 25 CLI commands with duplicated handler logic and a mandatory-workflow
state machine that only gated 4 tools. mcp-toolkit's CLI hand-mirrored two tools. Both showed that
parity needs a shared service layer plus generated CLI flags, not parallel implementations.

## Decision (current position)

**Service layer** (`packages/service`) is the only place with business logic. MCP tools and CLI
commands are thin adapters. Every input is a Zod schema in `packages/model`; MCP input schemas use
`.toJSONSchema()`, CLI flags come from ACME's `schema-to-flags` copy.

**MCP tools** (target: 10):

| Tool | Purpose |
|---|---|
| `memory_remember` | Create a memory (type, level, namespace, content, subject, tags, importance, ttl) |
| `memory_recall` | Query (ADR-005 Query schema), ranked hits with optional explain |
| `memory_context` | Pinned + top memories for a namespace, packed to a token budget |
| `memory_supersede` | New version of an existing memory |
| `memory_annotate` | Add links, tags, pin, importance without changing content |
| `memory_forget` | Tombstone |
| `memory_session` | Start or end a session; working memory TTL; end may trigger consolidation |
| `memory_consolidate` | Run dream passes (uses sampling delegation when available) |
| `memory_sync` | Fetch, merge, push shared logs |
| `memory_status` | Mounts, shard counts, index freshness, divergence, guidance |

**Resources**: `memory://<mount>/<memoryId>`, `memory://<mount>/context/<namespace>`,
`memory://<mount>/wiki/index.md`, `memory://<mount>/wiki/<page>`, `memory://status`.

**Prompts**: `memory-session-start` (how to use memory this session), `memory-when-to-remember`,
`memory-when-to-promote-to-procedural`, `memory-dream-review` (human review of a consolidation).

**Guidance injection**: tool results may end with a short `guidance` block (text). No server-side
workflow gating; the server is stateless (NFR-11) and the protocol is 2026-07-28.

**CLI** (oclif): `init`, `remember`, `recall`, `context`, `supersede`, `annotate`, `forget`,
`session`, `dream`, `sync`, `status`, `doctor`, `reindex`, `export`, `import`, `wiki build`,
`promote`, `purge`, `mcp start|install`. Each command's flags are generated from the same schema
its tool uses; `--json` everywhere.

## Alternatives considered

- Fewer, more generic tools (`memory_write` with an `op` field). Rejected: agents choose better
  among clearly named tools, and per-tool descriptions carry the guidance.
- Server-enforced workflow (must call status first). Rejected: ACME showed it is brittle and
  stateless HTTP makes it impossible; guidance beats gating.

## Consequences

- Any new capability is added to the service and both adapters in one change; a parity test
  asserts every tool has a command and vice versa.

## Decided

- One memory per `memory_remember` call, keeping per-write guidance sharp (default, 2026-09-28).
- `memory_session` stays a tool; not every client sends a session id in request metadata
  (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M3): the ten tools are defined once as `TOOL_SPECS` in the service package (name,
  description, Zod input, read-only hint, handler, CLI command name). The MCP server registers
  them with `McpServer.registerTool` straight from the Zod schema; the CLI generates flags from
  the same schema; the tier 1 parity test loads each built command and checks every schema field
  is a flag or argument. Adding a tool without a command fails CI.
- 2026-09-29 (M3): guidance injection is a `guidance` string on the tool result, appended to the
  text content and returned in `structuredContent`. First use: `memory_remember` reports similar
  existing memories and suggests `memory_supersede`. No workflow gating anywhere.
- 2026-09-29 (M3): `memory_session start` returns the session id, its `session/<id>` namespace and
  the context block; `end` runs the expire pass for that namespace. Session ids are normalised to
  valid namespace segments (ULIDs are uppercase; namespaces are not).
- 2026-09-29 (M3): resources are `memory://status`, `memory://context` and the template
  `memory://{mount}/{memoryId}`; prompts are the three guidance documents, authored once in
  `packages/model/src/guidance` and also rendered into CLAUDE.md and the ynh skill (ADR-013).
