# ADR-006: Ingest, consolidate, decay, forget

Status: accepted (2026-09-29)
Satisfies: FR-6, FR-12, FR-13, FR-14, NFR-4, NFR-13

## Context

Every serious system separates hot-path writes from background consolidation: LangMem hot path vs
background, Letta sleep-time agents, Vertex Memory Bank async consolidation, Claude Code Auto
Dream, Anthropic Managed Agents "Dreams" (which produce a new store and never mutate the input).
Karpathy's "lint" is the same idea run by hand. Decay and forgetting are either TTL/expiry (Mem0,
Memory Bank) or scoring (Generative Agents recency, MemoryOS heat).

## Decision

**Ingest (hot path).** `memory_remember` writes exactly what the agent gives it, plus provenance
and defaults. The write path is **generation-free**: no Writer call, and the server needs no model
credentials to accept writes or answer recall. A configured Judge (ADR-012) runs typed judgments on
the write path (importance, near-duplicate flag, redaction gate) by default when a key is present,
and can be turned off per store. Near-duplicate candidates come from the lexical index. Guidance on
*what* to remember comes from prompts and resources (copied and rewritten from ACME's thought/rule
creation prompts) and from a short guidance block the server appends to `memory_remember` results
(e.g. "3 similar memories exist: consider `memory_supersede`"). `memory_remember` warns on
duplicates, never refuses. Extraction-on-write remains possible later as an opt-in ingest plug-in
behind the same seams.

**Models.** Models sit behind two seams defined in ADR-012: a **Judge** (decision model, typed
answers with calibrated probabilities; TypeSafe Jev is the first implementation) and a **Writer**
(generative model with structured output validated by Zod; `mcp-sampling`, `anthropic`,
`openai-compatible`, `none`). Both are pluggable and selected by config per store; the hosted
service configures its own credentials for the scheduled dream worker. Each dream pass is
specified as Judge questions, an optional Writer step, a no-model fallback and confidence bands;
the table in ADR-012 is the source for that mapping.

**Consolidate ("dream").** `ynm dream` / `memory_consolidate` runs six passes over one namespace,
implemented in `packages/service/src/dream`. Candidate pairs come from the index (each memory's
nearest neighbours of the same type and mount), capped per pass by `maxPairsPerRun`.

1. Expire: working memories past TTL get tombstones (no model).
2. Promote: working memories flagged `promote` become episodic or semantic records (no model).
3. Dedupe: near-duplicates are merged with `derives-from` links. The newer memory is kept; its
   text is merged through the Writer when one exists, otherwise the older is linked and
   tombstoned.
4. Contradict: memories sharing a `subject` with conflicting content get `contradicts` links on
   both sides; the older is tombstoned only when the Judge says the newer supersedes it
   (Zep-style invalidation, not deletion).
5. Reflect: for a subject with N+ episodic records, produce one `reflective` record summarising
   the series (Generative Agents reflection; requires a Writer). The reflection is written only
   after the Noul battery (unsupported claim, lost fact, wrong date) passes.
6. Normalise: relative dates are rewritten to absolute from `recordedAt` (no model); importance
   re-scored.

The wiki projection (ADR-010) is regenerated afterwards if enabled.

Every pass writes only new records (`supersede`, `annotate`, `tombstone`), and every decision that
changes a memory stores its judgment. Consolidation never rewrites history, so it is safe to run
on any clone and merges with everyone else's.

The review queue is `needsReview` on the memory (`ynm review list|clear`,
`ynm list --needs-review`). The dream report carries per-pass candidates, judged, changed,
flagged, skipped, fallback and token usage, and an estimated cost at Jev list price.

Triggers: explicit command or tool; `memory_session end`, which runs the expire pass for that
session's namespace; a configurable threshold (records since last dream); a scheduler in hosted
mode.

**Forget.** Three levels: hide (decay score falls below the recall floor), tombstone (explicit,
reversible by supersede), purge (physical removal). Purge is `ynm purge <id> --reason … --yes`:
it rewrites the affected shards, appends a `purge-marker` record and, with `--forget-history`,
starts the shard's ref history afresh. Because it rewrites refs it needs a coordinated sync.

## Alternatives considered

- LLM extraction on every write (Mem0 default). Rejected: cost and latency per tool call; the
  agent already knows what it wants to remember. Available later as an opt-in ingest plug-in.
- Rewrite-in-place consolidation producing a fresh store (Anthropic Dreams). Attractive for purity,
  but a second store per dream does not fit git notes' merge model. Our append-only records give
  the same auditability inside one ref.

## Consequences

- The Writer is optional and the no-model fallback is documented per pass.
- Heat (access counts) requires `annotate` records on recall, which adds writes; it is opt-in.
- The hosted dream runs as a separate worker process sharing the store, so a slow dream cannot
  stall the server.
- `memory_remember` warns on duplicates, never refuses.

## Open questions

None.

## History

- 2026-09-29 (M3): expire pass built first, exposed as `memory_consolidate` / `ynm dream` and run
  by `memory_session end`.
- 2026-09-29 (M4): all six passes built with index-sourced candidate pairs and stored judgments.
- 2026-09-29 (M4): review queue as `needsReview`; dream report with per-pass counts and cost.
- 2026-09-29 (M4): purge command with shard rewrite, purge marker and `--forget-history`.
- 2026-10-03: dreams are incremental. A full run marks each memory it finished with a `dreamed`
  annotate (content record, subject, judge); later runs judge only fresh memories and pairs with
  a fresh side, and with nothing fresh run only expire. Each pair has one owning fresh memory and
  every pass works in the same order, so a capped run leaves its owners fresh and the backlog
  shrinks. This implements the "records since last dream" trigger above in a form every clone
  shares.
- 2026-10-04: a reserved `occurrence` tag, set by the writer like `promote`, marks a memory as
  one occurrence of an event. Dedupe and contradict never pair it (it is neither owner nor
  neighbour and spends no pair budget); reflect still counts it as an episode, and its
  reflection drops the tag. It is marked dreamed like any other fresh memory. Chosen over a
  dream-config list of skipped namespaces or tags so the record says what it is wherever it goes.
- 2026-10-04: occurrence retention. The expire pass also tombstones memories tagged `occurrence`
  whose `updatedAt` is older than `dream.occurrenceRetention` (ISO 8601 duration, default
  `P90D`, `null` disables), with no model, reported as its own `retention` entry beside
  `expire`. An occurrence the newest live reflective memory on its subject links to is kept, and
  reflect now links only the newest twelve episodes it was written from, so a recurring subject's
  evidence moves forward and old occurrences age out. Retention runs before reflect, so stale
  occurrences no reflection rests on cannot add up to a new one. Tombstone rather than purge:
  space reclamation stays with `ynm purge`.
