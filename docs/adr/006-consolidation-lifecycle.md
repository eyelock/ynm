# ADR-006: Ingest, consolidate, decay, forget

Status: draft
Satisfies: FR-6, FR-12, FR-13, FR-14, NFR-4, NFR-13

## Context

Every serious system separates hot-path writes from background consolidation: LangMem hot path vs
background, Letta sleep-time agents, Vertex Memory Bank async consolidation, Claude Code Auto
Dream, Anthropic Managed Agents "Dreams" (which produce a new store and never mutate the input).
Karpathy's "lint" is the same idea run by hand. Decay and forgetting are either TTL/expiry (Mem0,
Memory Bank) or scoring (Generative Agents recency, MemoryOS heat).

## Decision (current position)

**Ingest (hot path).** `memory_remember` writes exactly what the agent gives it, plus provenance
and defaults. No LLM call on the write path. Guidance on *what* to remember comes from prompts and
resources (copied and rewritten from ACME's thought/rule creation prompts) and from a short
guidance block the server appends to `memory_remember` results (e.g. "3 similar memories exist:
consider `memory_supersede`"). Near-duplicate detection at write time uses the lexical index only.

**Consolidate ("dream").** `ynm dream` / `memory_consolidate` runs passes over one namespace:

1. Expire: working memories past TTL get tombstones (no LLM).
2. Promote: working memories flagged `promote` become episodic or semantic records (no LLM).
3. Dedupe: lexical near-duplicates are merged into one `supersede` with `derives-from` links.
   Merge text is produced by host-LLM sampling (pull-model delegation copied from mcp-toolkit) or,
   without a sampling-capable client, by keeping the newest and linking the rest.
4. Contradict: memories sharing a `subject` with conflicting content get `contradicts` links and,
   with an LLM, a resolution `supersede` on the older one (Zep-style invalidation, not deletion).
5. Reflect: for a subject with N+ episodic records, produce one `reflective` record summarising
   the series (Generative Agents reflection; requires LLM).
6. Normalise: relative dates to absolute; importance re-scored.
7. Regenerate the wiki projection (ADR-010) if enabled.

Every pass writes only new records (`supersede`, `annotate`, `tombstone`). Consolidation never
rewrites history, so it is safe to run on any clone and merges with everyone else's.

Triggers: explicit command or tool; session end via client hook; a configurable threshold (records
since last dream); a scheduler in hosted mode.

**Forget.** Three levels: hide (decay score falls below the recall floor), tombstone (explicit,
reversible by supersede), purge (physical removal of lines from a shard plus a `purge-marker`
record; requires `--yes` and rewrites that shard's ref, so it needs a coordinated sync).

## Decided

- The write path is LLM-free (2026-09-28). `memory_remember` stores explicit records plus
  provenance, defaults and a lexical near-duplicate warning. The server needs no model credentials
  to accept writes or answer recall.
- Models sit behind two seams defined in ADR-012: a **Judge** (decision model, typed answers with
  calibrated probabilities; TypeSafe Jev is the first implementation) and a **Writer** (generative
  model with structured output validated by Zod; `mcp-sampling`, `anthropic`,
  `openai-compatible`, `none`). Both are pluggable and selected by config per store; the hosted
  service configures its own credentials for the scheduled dream worker.
- Writes are **generation-free**. A configured Judge runs typed judgments on the write path
  (importance, near-duplicate flag, redaction gate) by default when a key is present, and can be
  turned off per store (ADR-012).
- Each dream pass is specified as: Judge questions, optional Writer step, no-model fallback,
  confidence bands. The table in ADR-012 is the source for that mapping.
- Extraction-on-write remains possible later as an opt-in ingest plug-in behind the same seams.

## Alternatives considered

- LLM extraction on every write (Mem0 default). Rejected: cost and latency per tool call; the
  agent already knows what it wants to remember. Available later as an opt-in ingest plug-in.
- Rewrite-in-place consolidation producing a fresh store (Anthropic Dreams). Attractive for purity,
  but a second store per dream does not fit git notes' merge model. Our append-only records give
  the same auditability inside one ref.

## Consequences

- Sampling must be optional and the local fallback must be documented per pass.
- Heat (access counts) requires `annotate` records on recall, which adds writes; make it opt-in.
- The hosted dream runs as a separate worker process sharing the store, so a slow dream cannot
  stall the server (default, 2026-09-28).
- `memory_remember` warns on duplicates, never refuses (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M3): the first pass exists ahead of M4: `expire` tombstones working memory whose
  ttl has elapsed (no model). Exposed as `memory_consolidate` and `ynm dream`, and run by
  `memory_session end` for that session's namespace.
