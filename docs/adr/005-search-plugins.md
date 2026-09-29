# ADR-005: Index and ranking plug-in seam

Status: accepted (2026-09-29)
Satisfies: FR-8, FR-9, FR-10, FR-11, NFR-2, NFR-13

## Context

ACME had no index: every query scanned every note. Karpathy's wiki uses `index.md` and admits it
stops working past a few hundred pages, recommending qmd (BM25 + vector + rerank). The production
systems all do hybrid retrieval fused by rank (Zep, Hindsight, Mem0 2026, Letta). The DPC Messenger
follow-up showed that querying git objects directly is too slow per turn; a derived index is
mandatory.

## Decision

The index is a pluggable seam mirroring the store (ADR-004). No implementation reads the store
directly: all are fed from `append` results (incremental) and from a full scan (`rebuild`), and
each must pass a shared index conformance suite before it can be configured. The log stays plain
JSONL regardless of index choice.

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
  // default: reciprocal rank fusion across indexes, then a weighted sum of relevance,
  // recency (decay per type), importance and pinned; weights below
}

interface Reranker {
  rerank(q: Query, candidates: Ranked[], k: number): Promise<Ranked[]>;
  // final stage over the top K (default 15) when a calibrated Judge (ADR-012) is configured
  // via `dream.rerank`: one Noul per candidate asking whether the memory helps with the query,
  // batched in one request, blended 0.7 judge / 0.3 prior score. Per-query `rerank: false`
  // disables it; without a Judge the stage is skipped.
}
```

**Built in.** A **lexical** index (SQLite FTS5 through `node:sqlite`, so the project has no native
module; engines are pinned to Node 22.13+, where `node:sqlite` is unflagged) stored under
`.ynm/index/` (gitignored) or `~/.ynm/index/<store>`, with BM25 ranking, column weights summary
2.0, content 1.0, subject 1.5, tags 1.0, and porter stemming; and a **metadata** index (type,
level, namespace, subject, tags, time, memoryId → shards) in the same SQLite file, so metadata
filters go in the same query. FTS rows share the memories table's rowid so replace and remove are
indexed lookups (`memoryId` is UNINDEXED in FTS5, and deleting by it scanned the whole table:
7.8 s to index 10k, fifteen minutes at 100k), and a rebuild skips the lookup on emptied tables.

Plug-ins: vector (local embeddings or remote API), graph (subject and link traversal), external
(qmd, a hosted search). Discovered by config (`index.plugins: [...]`), loaded by module name.
Other implementations may be a serialised JSON in-memory index, Redis with search, Postgres, a
vector index, or an external engine such as qmd.

**Freshness.** The index records, per shard, the log revision it last saw (git ref sha, file
mtime, counter). A read compares those with the log's current shard revisions, one `for-each-ref`
plus one small query when fresh, and any difference rebuilds that mount's index from a full scan.
The index also stores each memory's folded state alongside its projection: a process that just
appended applies its own records to that state with the fold's `applyRecord` and upserts, so its
own writes are visible immediately without a rebuild. If the append result shows another writer
touched the shard in between (`previous` revision differs from the one the index saw), the shard
is marked stale and the next read rebuilds.

**Ranking.** Weights as shipped: with text, relevance 0.6, recency 0.2, importance 0.15, pinned
0.05; filter-only, recency 0.55, importance 0.35, pinned 0.1. Recency decay half-lives per type:
working 1 day, episodic 14 days, reflective 90 days, semantic 180 days, procedural and reference
none. Both are tuned against ADR-014 tier 1.

The `Query` schema is the single MCP/CLI recall input: `text`, `type[]`, `level[]`,
`namespacePrefix`, `subject`, `tags[]`, `since/until`, `limit`, `includeTombstoned`, `explain`,
`rerank`. `explain: true` returns the score components so an agent can see why something ranked.

Pinned context (`memory_context`): the fold's `pinned` memories (an `annotate` op with
`pinned: true`) plus the top ranked by importance and recency, packed to a token budget, rendered
as markdown. This is the always-in-context tier (Letta blocks, MEMORY.md).

## Alternatives considered

- Brute-force in-memory filter over the fold (ACME). Rejected by FR-10.
- Making vector search the default. Rejected: needs a model, breaks NFR-13 (no LLM to read), and
  lexical + metadata already beats brute force. Vector is the first plug-in to prove the seam.
- Storing the index in git. Rejected: it is derived, large, and rebuildable.

## Consequences

- Index freshness is a doctor check; `ynm reindex` rebuilds from the log. Exactness of the
  incremental path is proven by the service recall tests and the reindex-reproduces-hits gate
  check.
- Every provider must emit appended records so the index can update incrementally.

## Open questions

- Recall breakdown per type and namespace is not yet reported by the retrieval suite; the gate
  measures overall recall@k and MRR. Add the breakdown when the corpus is large enough per type to
  be meaningful.

## History

- 2026-09-29 (M4): Judge-backed reranker became the final recall stage when a calibrated judge is
  configured.
- 2026-09-29 (M2): `node:sqlite` spike passed; the default index dropped the native module and
  engines were pinned to Node 22.13+.
- 2026-09-29 (M2): freshness defined as shard-revision comparison with per-mount rebuild on
  difference.
- 2026-09-29 (M2): index stores folded state and applies its own appends via `applyRecord`,
  marking shards stale on foreign writes.
- 2026-09-29 (M2): ranker and FTS5 column weights recorded as shipped.
- 2026-09-29 (M2): quadratic FTS delete path fixed by sharing the memories table's rowid.
- 2026-09-29 (M2): per-type and per-namespace recall breakdown noted as missing from the
  retrieval suite.
