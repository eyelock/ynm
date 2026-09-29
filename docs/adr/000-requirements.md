# ADR-000: Requirements

Status: accepted (2026-09-29)

## Context

ynm ("your named memory") is the sibling of ynh ("your named harness"): a small MCP server and
CLI, in TypeScript, that gives agents the standard set of production memory types, records every
memory as an append-only record in git notes, and exposes plug-in points for storage, search,
models, wiki output and client integration. Memory exists at a personal level (one user, never
shared by default) and a distributed level (shared through git remotes or a hosted store).

These are the requirements the other ADRs cite by id. They are decisions about scope, so they
live with the ADRs and follow the same draft, addenda, consolidate lifecycle.

## Functional requirements

Numbered so ADRs and tests can cite them.

### Memory model
- FR-1 Support six memory types: working, episodic, semantic, procedural, reflective, reference.
- FR-2 Every memory has a scope on two axes: **level** (personal, distributed) and **namespace**
  (user, agent, session, project, organisation), plus free-form tags and an optional subject
  (entity or topic key) for episodic recurrence.
- FR-3 Every memory carries provenance (who or what wrote it, session, source, tool), confidence,
  importance, and bi-temporal validity.
- FR-4 Memories are never edited in place. Changes are new records that supersede, correct, or
  tombstone earlier ones. The current state is a fold over the log.
- FR-5 Memories may link to other memories with typed relations (supersedes, derives-from,
  contradicts, supports, about-entity, in-session).
- FR-6 Working memory has a TTL and is scoped to a session; it can be promoted to long-term types.

### Recording and retrieval
- FR-7 An agent can remember, recall, update (supersede), forget (tombstone), and list memories
  through MCP tools, and a human can do the same through the CLI with full parity.
- FR-8 Recall accepts a query, type and scope filters, a time window, tags, subject, and a limit,
  and returns ranked results with the score components (relevance, recency, importance) visible.
- FR-9 A "core" or pinned set of memories can be returned as a compact context block for the
  start of a session, bounded by a token budget.
- FR-10 Search is pluggable: a lexical index is built in and always works; vector, graph and
  hybrid rankers are plug-ins behind one interface. The default is not a brute-force scan.
- FR-11 Indexes are derived and rebuildable from the log at any time (`ynm reindex`).

### Lifecycle
- FR-12 Consolidation ("dream"): dedupe, merge, resolve contradictions, promote working to long
  term, produce reflective memories, convert relative dates to absolute. Runs on demand, on a
  schedule, or on a trigger (N sessions, N records). Uses host-LLM sampling when available and a
  local, non-LLM fallback where possible.
- FR-13 Forgetting: TTL expiry, explicit tombstones, and decay scoring that hides but never
  destroys history. Physical purge is a separate, explicit, audited operation.
- FR-14 Ingest guidance: MCP prompts and resources tell the agent when and what to remember, and
  the server can inject guidance into tool results.
- FR-14a Review queue: any model-driven change whose confidence falls in the "review" band is
  applied or withheld per pass policy and flagged `needsReview`; `memory_status`, the wiki and a
  review prompt surface the queue, and a human or agent can confirm or reverse it.

### Storage and sync
- FR-15 Git notes is the primary durable store. Records are line-oriented JSON so notes merge with
  `cat_sort_uniq`.
- FR-16 Personal memory is never pushed unless explicitly configured with a destination.
  Distributed memory is synchronised with a fetch, merge, push, retry loop.
- FR-17 Other storage providers (filesystem, SQLite, in-memory) implement the same record store
  interface so tests, offline use and non-git hosting all work.
- FR-18 Multiple stores can be mounted at once (for example personal + project + organisation) and
  recall can span them with the origin store visible on each result.

### Wiki projection
- FR-19 A compiled markdown projection (index, log, entity and topic pages) can be generated from
  the log, Karpathy-style, so humans and agents can read and grep it. It is a view, not the truth.

### Operations
- FR-20 `ynm init` bootstraps a repo or a dedicated memory repo: anchor, refspecs, hooks, config,
  and a starter CLAUDE.md or AGENTS.md snippet.
- FR-20a Client integration through a `ClientAdapter` seam with adapters for Claude Code, GitHub
  Copilot CLI, OpenCode, Pi (extension plus CLI skill, since Pi has no MCP) and ynh (harness
  plugin with MCP server, skills, rules, hooks and a memory-context sensor). See ADR-013.
- FR-21 `ynm doctor` checks refspecs, hooks, divergence, index freshness and reports problems.
- FR-22 Export and import in JSONL for migration and backup.

## Non-functional requirements

- NFR-1 **Correctness under concurrency.** Two writers on one machine never lose a record (local
  lock plus `update-ref` compare-and-swap with retry). Two clones never lose a record on sync.
- NFR-2 **Read performance.** Loading a store must not spawn one process per record. Target: a
  full log load of 10k records under 1 s using batched plumbing; recall answered from the index in
  under 100 ms for lexical search.
- NFR-3 **Write performance.** An append is O(shard size), not O(store size). Shards are bounded.
- NFR-4 **Durability and auditability.** Every change is a git commit on a notes ref; `git log` on
  the ref is the audit trail. Purge is explicit and leaves a record.
- NFR-5 **Privacy.** Personal and distributed memory live on different refs and never mix. A
  memory's level is fixed at write time; promotion from personal to distributed is an explicit copy
  with a new record. Sensitive content can be redacted before any derived write.
- NFR-6 **Portability of hosting.** stdio for local clients; Streamable HTTP for hosted use, with
  bearer, OAuth introspection or JWT. Works on GitHub, GitLab, Bitbucket, a bare repo on disk, and
  with no remote at all.
- NFR-7 **Schema evolution.** Every record has a schema version. Readers are tolerant: one bad
  line is skipped and reported, never fatal.
- NFR-8 **Robustness to git history rewrites.** Memory never depends on feature commits surviving.
  Anchors are stable objects that no rebase touches.
- NFR-9 **Small surface.** Fewer than 12 MCP tools. One Zod schema per record type is the single
  source of truth for MCP input schemas and CLI flags.
- NFR-10 **Testability.** Unit tests adjacent to code, provider conformance tests shared across
  providers, integration tests against real git repos, and at least one true protocol-level MCP
  client-server test. Coverage target 80% on new code.
- NFR-11 **Stateless server.** Any per-request state travels with the request (SDK v2 model). No
  process-global session singletons.
- NFR-12 **Observability.** Structured JSON logs to stderr with OTel severity; no stdout writes in
  stdio mode.
- NFR-13 **No LLM required to read.** Recall, list, export, doctor and reindex work without any
  model. Only consolidation and importance scoring may call an LLM, and they degrade gracefully.
- NFR-14 **Zero-config first run.** In a git repo, `ynm` works with a personal store immediately;
  distributed sync is opt-in.
- NFR-16 **Continuously measured.** Semantics, merge safety, latency budgets and retrieval quality
  are gated on every PR; consolidation quality, guidance efficacy and cost nightly; public
  benchmarks per release (ADR-014). Budgets are numbers in a versioned file.
- NFR-15 **Typed model I/O.** Every interaction with a model is structured: JSON state in, typed
  answers or schema-validated objects out. No pass parses free text. Decision models (TypeSafe
  Jev) and generative models sit behind separate seams (ADR-012); judgments are stored as data
  with probabilities and confidence, and thresholds live in config.

## History

- No addenda were recorded before consolidation; the requirements above stand as first drafted.
