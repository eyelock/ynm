# ADR-008: MCP tools, resources, prompts and CLI parity

Status: accepted (2026-09-29)
Satisfies: FR-7, FR-8, FR-9, FR-14, NFR-9, NFR-11

## Context

ACME exposed 38 tools and 25 CLI commands with duplicated handler logic and a mandatory-workflow
state machine that only gated 4 tools. mcp-toolkit's CLI hand-mirrored two tools. Both showed that
parity needs a shared service layer plus generated CLI flags, not parallel implementations.

## Decision

**Service layer** (`packages/service`) is the only place with business logic. MCP tools and CLI
commands are thin adapters. Every input is a Zod schema in `packages/model`; MCP input schemas use
`.toJSONSchema()`, CLI flags come from ACME's `schema-to-flags` copy.

**MCP tools** are the ten below, defined once as `TOOL_SPECS` in the service package (name,
description, Zod input, read-only hint, handler, CLI command name). The MCP server registers them
with `McpServer.registerTool` straight from the Zod schema; the CLI generates its flags from the
same schema.

| Tool | Purpose |
|---|---|
| `memory_remember` | Create one memory (type, level, namespace, content, subject, tags, importance, ttl) |
| `memory_recall` | Query (ADR-005 Query schema), ranked hits with optional explain |
| `memory_context` | Pinned + top memories for a namespace, packed to a token budget |
| `memory_supersede` | New version of an existing memory |
| `memory_annotate` | Add links, tags, pin, importance without changing content |
| `memory_forget` | Tombstone |
| `memory_session` | Start or end a session; working memory TTL; end runs the expire pass |
| `memory_consolidate` | Run dream passes (uses sampling delegation when available) |
| `memory_sync` | Fetch, merge, push shared logs |
| `memory_status` | Mounts, shard counts, index freshness, divergence, guidance |

`memory_remember` creates one memory per call, keeping per-write guidance sharp. `memory_session`
is a tool rather than request metadata because not every client sends a session id: `start`
returns the session id, its `session/<id>` namespace and the context block; `end` runs the expire
pass for that namespace. Session ids are normalised to valid namespace segments (ULIDs are
uppercase; namespaces are not).

**Resources**: `memory://status`, `memory://context`, the template `memory://{mount}/{memoryId}`,
and the wiki template `memory://{mount}/wiki/{path}` (ADR-010).

**Prompts**: the three guidance documents `memory-session-start` (how to use memory this
session), `memory-when-to-remember` and `memory-when-to-promote-to-procedural`. They are authored
once in `packages/model/src/guidance` and also rendered into CLAUDE.md and the ynh skill
(ADR-013).

**Guidance injection**: a tool result may carry a `guidance` string, appended to the text content
and returned in `structuredContent`. First use: `memory_remember` reports similar existing
memories and suggests `memory_supersede`. No server-side workflow gating anywhere; the server is
stateless (NFR-11) and the protocol is 2026-07-28.

**CLI** (oclif): `init`, `remember`, `recall`, `context`, `supersede`, `annotate`, `forget`,
`session`, `dream`, `sync`, `status`, `doctor`, `reindex`, `export`, `import`, `wiki build|ingest`,
`promote`, `purge`, `pin`, `list`, `review`, `client install|plan|status` (ADR-013) and `serve`
(the MCP server: stdio by default, `--http` for the hosted service, ADR-009). Each tool-backed
command's flags are generated from the same schema its tool uses; `--json` everywhere.

## Alternatives considered

- Fewer, more generic tools (`memory_write` with an `op` field). Rejected: agents choose better
  among clearly named tools, and per-tool descriptions carry the guidance.
- Server-enforced workflow (must call status first). Rejected: ACME showed it is brittle and
  stateless HTTP makes it impossible; guidance beats gating.

## Consequences

- Any new capability is added to the service and both adapters in one change. The tier 1 parity
  test loads each built command and checks every schema field is a flag or argument; adding a
  tool without a command fails CI.

## Open questions

None.

## History

- 2026-09-29 (M3): ten tools defined once as `TOOL_SPECS`; CLI flags and parity test derived
  from the same Zod schema.
- 2026-09-29 (M3): guidance is a `guidance` string on the tool result; first used by
  `memory_remember`.
- 2026-09-29 (M3): `memory_session` start/end semantics and session id normalisation.
- 2026-09-29 (M3): resources reduced to status, context and the memory template; prompts are the
  three guidance documents shared with CLAUDE.md and the ynh skill.
- 2026-09-30: `hook` added to the CLI, a client-facing command with no tool (agent hooks read
  and write the client's JSON); see [ADR-016](016-agent-guidance-delivery.md).
- 2026-09-29: correction: the third guidance prompt is registered as `memory-when-to-promote` (not `memory-when-to-promote-to-procedural`), and four resources are registered: `memory://status`, `memory://context`, the memory template and the wiki template.
