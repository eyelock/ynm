# ADR-002: Append-only record format, identity, supersession, time

Status: accepted (2026-09-29)
Satisfies: FR-3, FR-4, FR-5, FR-13, NFR-4, NFR-7

## Context

Git notes merge conflict-free only if records are line-oriented and order-independent
(`cat_sort_uniq` concatenates, sorts and dedupes lines). The modern consolidation approach
(Mem0 2026, Zep, Supermemory) is append-and-supersede rather than edit-in-place. ACME re-appended
whole entries with the same id and resolved "latest" three different ways; effort entries had no id
at all.

## Decision

One JSON object per line. Each line is an immutable **record**. A **memory** is the fold of all
records sharing a `memoryId`. Current state is derived, never stored.

```
{
  "v": 1,                          // schema version
  "id": "01J...",                   // ULID, unique per record, sortable by time
  "memoryId": "01J...",             // ULID of the memory this record belongs to (== id for the first)
  "op": "create" | "supersede" | "annotate" | "tombstone" | "purge-marker" | "snapshot",
  "type": "semantic",               // ADR-001
  "level": "distributed",
  "namespace": "project/ynm",
  "subject": "entity:git-notes",
  "tags": ["git", "storage"],
  "content": "...",                 // markdown text; the memory itself (required)
  "summary": "...",                 // one line, used by index.md and pinned context
  "data": { ... },                  // optional JSON object for typed memories (profiles, fact sheets)
  "dataSchema": "user-profile/1",   // optional string tag naming the expected shape of data
  "importance": 0.7,                // 0..1
  "confidence": 0.9,                // 0..1
  "recordedAt": "2026-09-28T10:00:00Z",   // transaction time
  "validFrom": "2026-09-28T10:00:00Z",    // event time (bi-temporal)
  "validTo": null,
  "ttl": null,                       // ISO duration; working memory only
  "provenance": { "actor": "agent:claude-code", "session": "...", "source": "...", "tool": "..." },
  "links": [ { "rel": "supersedes", "to": "01J..." }, { "rel": "derives-from", "to": "..." } ]
}
```

Rules:

- `id` and `memoryId` are ULIDs so sorting by id is sorting by time and `cat_sort_uniq` reordering
  is harmless.
- `content` is markdown and required. `data` is an optional JSON object for typed memories, with
  `dataSchema` as a plain string tag naming its expected shape; there is no schema registry.
- `supersede` carries the full new content, not a diff, and links `supersedes` the prior record.
  It replaces `data` whole, like `content`. The fold takes the latest `supersede` by `recordedAt`
  as current. Ties broken by `id`.
- `tombstone` hides the memory from recall and the wiki; history remains. `purge-marker` records
  that a physical purge was performed (the purged lines are gone; the marker is the audit trail).
- `annotate` adds links, tags or score changes without changing content (e.g. a consolidation pass
  raising importance, or recording an access for heat). Model judgments that changed a memory are
  stored as `annotate` records with `data: { judgments: [...] }` holding questions, answers,
  probabilities, confidence, model id and version (ADR-012), so weights can be recombined without
  re-inference and the audit trail shows why.
- `importance` is set by the writer (default 0.5) and re-scored only by the dream pass, since the
  write path is LLM-free (ADR-006).
- `snapshot` holds the folded state of a shard at `recordedAt` (a checkpoint). Readers may start
  the fold from the latest snapshot and apply only later records. Snapshots are written by the
  dream pass and by `ynm compact`; they are optimisation, never the only copy of anything.
- Readers skip and report any line that fails to parse or has an unknown `v`. Never fatal.
- Relations: `supersedes`, `derives-from`, `contradicts`, `supports`, `about`, `in-session`.

## Alternatives considered

- Edit in place (rewrite the note blob). Rejected: destroys history, breaks `cat_sort_uniq`, and
  makes concurrent writers conflict.
- UUIDv4 ids. Rejected: not time-sortable; ULID gives free chronological order after a merge.
- Storing diffs for supersede. Rejected: the fold would need every prior record; full content keeps
  the fold O(1) per memory.

## Consequences

- Storage grows with every change. Bounded by sharding (ADR-003) and by purge.
- Every provider (ADR-004) implements the same fold; it lives in `store` and is tested once.
- The wiki (ADR-010) and indexes (ADR-005) are pure functions of the folded state. The wiki
  renders `data` as frontmatter; the index puts its string values into the lexical index and its
  keys into the metadata index so recall can filter on them.

## Open questions

None.

## History

- 2026-10-03: fold reads `data.dreamed` on an `annotate` into the memory's `dreamed` (ADR-006).
  An annotate carrying only that is bookkeeping and does not move `updatedAt`.
