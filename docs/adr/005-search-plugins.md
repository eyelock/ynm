# ADR-005: Index and ranking plug-in seam

Status: draft
Satisfies: FR-8, FR-9, FR-10, FR-11, NFR-2, NFR-13

## Context

ACME had no index: every query scanned every note. Karpathy's wiki uses `index.md` and admits it
stops working past a few hundred pages, recommending qmd (BM25 + vector + rerank). The production
systems all do hybrid retrieval fused by rank (Zep, Hindsight, Mem0 2026, Letta). The DPC Messenger
follow-up showed that querying git objects directly is too slow per turn; a derived index is
mandatory.

## Decision (current position)

```ts
interface MemoryIndex {
  readonly name: string;                              // "lexical", "vector:<model>", "graph"
  rebuild(memories: AsyncIterable<Memory>): Promise<void>;
  upsert(memories: Memory[]): Promise<void>;          // incremental, called after append
  remove(memoryIds: string[]): Promise<void>;         // tombstones
  search(q: Query): Promise<Hit[]>;                   // Hit = { memoryId, score, why }
  capabilities(): { lexical: boolean; semantic: boolean; graph: boolean };
}

interface Ranker {
  rank(hits: Hit[][], memories: Map<string, Memory>, q: Query): Ranked[];
  // default: reciprocal rank fusion across indexes, then
  // score = w_rel * relevance + w_rec * recency(decay per type) + w_imp * importance + w_heat * heat
}

interface Reranker {
  rerank(q: Query, candidates: Ranked[], k: number): Promise<Ranked[]>;
  // optional final stage over the top K. Default implementation uses the Judge seam (ADR-012):
  // one Noul per (query, candidate) asking whether the memory answers the query, batched in one
  // request; TypeSafe's rerank cookbook shows this reordering a BM25 shortlist with large gains.
  // Without a Judge the stage is skipped.
}
```

Built in: a **lexical** index (SQLite FTS5 via better-sqlite3, or MiniSearch pure JS; see open
questions) stored under `.ynm/index/` (gitignored) or `~/.ynm/index/<store>`; a **metadata**
index (type, level, namespace, subject, tags, time, memoryId → shards) in the same SQLite file.

Plug-ins: vector (local embeddings or remote API), graph (subject and link traversal), external
(qmd, a hosted search). Discovered by config (`index.plugins: [...]`), loaded by module name.

The `Query` schema is the single MCP/CLI recall input: `text`, `type[]`, `level[]`,
`namespacePrefix`, `subject`, `tags[]`, `since/until`, `limit`, `includeTombstoned`, `explain`.
`explain: true` returns the score components so an agent can see why something ranked.

Pinned context (`memory_context`): the fold's `pinned` memories (an `annotate` op with
`pinned: true`) plus the top ranked by importance and recency, packed to a token budget, rendered
as markdown. This is the always-in-context tier (Letta blocks, MEMORY.md).

## Alternatives considered

- Brute-force in-memory filter over the fold (ACME). Rejected by FR-10.
- Making vector search the default. Rejected: needs a model, breaks NFR-13 (no LLM to read), and
  lexical + metadata already beats brute force. Vector is the first plug-in to prove the seam.
- Storing the index in git. Rejected: it is derived, large, and rebuildable.

## Consequences

- Index freshness is a doctor check; `ynm reindex` rebuilds from the log.
- Every provider must emit appended records so the index can update incrementally.

## Decided

- The index is a pluggable seam mirroring the store (2026-09-28). Implementations may be SQLite
  FTS5, a serialised JSON in-memory index, Redis with search, Postgres, a vector index, or an
  external engine such as qmd. No implementation reads the store directly: all are fed from
  `append` results (incremental) and from a full scan (`rebuild`). Each must pass a shared index
  conformance suite before it can be configured.
- SQLite FTS5 is the default implementation: one gitignored file, BM25 ranking, and the metadata
  filters in the same query. Phase 2 includes a spike on `node:sqlite` (Node 22+) to check whether
  FTS5 is enabled in the bundled build, which would remove the native dependency.
- The log stays plain JSONL regardless of index choice.
- Recency decay half-lives (default, 2026-09-28): working 1 day, episodic 14 days, reflective 90 days,
  semantic 180 days, procedural and reference none. Calibrate against ADR-014 Tier 1.

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M2): the `node:sqlite` spike passed. Node 24's bundled SQLite (3.53) has FTS5 with
  `bm25()`, so the default index uses `node:sqlite` and the project has no native module.
  Engines pinned to Node 22.13+, where `node:sqlite` is unflagged.
- 2026-09-29 (M2): freshness is decided by comparing the log's shard revisions (git ref sha, file
  mtime, counter) with the revisions the index recorded; any difference rebuilds that mount's
  index from a full scan. One `for-each-ref` plus one small query when fresh.
- 2026-09-29 (M2): the index stores each memory's folded state alongside its projection. A
  process that just appended applies its own record to that state with the fold's `applyRecord`
  and upserts, so its own writes are visible immediately without a rebuild. If the append shows
  another writer touched the shard in between (`previous` revision differs from the one the index
  saw), the shard is marked stale and the next read rebuilds. Exactness is proven by the service
  recall tests and the reindex-reproduces-hits gate check.
- 2026-09-29 (M2): ranker weights as shipped: with text, relevance 0.6, recency 0.2, importance
  0.15, pinned 0.05; filter-only, recency 0.55, importance 0.35, pinned 0.1. FTS5 column weights
  summary 2.0, content 1.0, subject 1.5, tags 1.0, porter stemming. Tune against ADR-014 tier 1.
- 2026-09-29 (M2): first bench of the SQLite index found a quadratic write path: deleting the old
  FTS row by `memoryId` scans the FTS table because that column is UNINDEXED in FTS5 (7.8 s to
  index 10k, fifteen minutes at 100k). FTS rows now share the memories table's rowid so replace
  and remove are indexed lookups, and a rebuild skips the lookup on emptied tables.
- 2026-09-29 (M2): recall breakdown per type and namespace is not yet reported by the retrieval
  suite; the gate measures the overall recall@k and MRR. Add the breakdown when the corpus is
  large enough per type to be meaningful.
