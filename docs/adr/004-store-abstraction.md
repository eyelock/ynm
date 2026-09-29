# ADR-004: Record store interface and providers

Status: draft
Satisfies: FR-17, FR-18, NFR-1, NFR-10, NFR-11

## Context

ACME's `StorageProvider` was a synchronous string read/write over "locations" with no append, no
lock, no CAS and no query, so all logic leaked into the repository layer. mcp-toolkit's session
provider has the better shape (consumer/publisher split, TTL envelope, conformance suite) but is
hard-typed to session config.

## Decision (current position)

**Layering rule.** git notes is a provider, not the design. Three layers:

1. Record model (ADR-002): JSONL lines, ops, ids, links, and the fold. Store-agnostic.
2. Record log interface (below): `append`, `scan`, `shards`, `health`, optional `sync`. Shards are
   named by level, namespace, type and month; that naming is shared by every provider so a
   memory's location is the same idea everywhere.
3. Providers: `git-notes`, `fs`, `sqlite`, `memory`. Anchors, plumbing writes, compare-and-swap
   and `cat_sort_uniq` merging live only inside the git provider.

Nothing above layer 2 may import from a provider. The index, ranker, service, MCP and CLI talk to
layer 2 only. A provider that lacks `sync` is treated as non-replicating.

Two interfaces in `packages/store`, both async:

```ts
interface RecordLog {
  readonly id: string;                 // mount id, e.g. "personal", "project", "org"
  readonly level: Level;               // every log is entirely personal or entirely distributed
  append(records: MemoryRecord[]): Promise<AppendResult>;   // atomic, CAS, returns commit/ref info
  scan(filter: ShardFilter): AsyncIterable<MemoryRecord>;   // by namespace/type/time prefix
  shards(): Promise<ShardInfo[]>;
  sync?(opts): Promise<SyncResult>;    // optional; git-notes only
  health(): Promise<HealthReport>;
}

interface WorkingStore<T> {            // ephemeral, TTL'd; copied from mcp-toolkit provider
  get(key): Promise<T | null>; set(key, value, ttlMs?); delete(key); expire();
}
```

The **fold** (records → current memories) is a pure function in `store/fold.ts`, shared by every
provider. Providers only move lines.

Providers:

| Provider | Backing | Use |
|---|---|---|
| `git-notes` | ADR-003 layout | Primary, durable, syncable |
| `fs` | `<dir>/<level>/<ns>/<type>/<yyyy-mm>.jsonl`, atomic rename, lockfile | Offline, non-git hosting, tests |
| `sqlite` | one table of records | Hosted service without git, very large stores |
| `memory` | arrays | Unit tests |

A **mount table** in `service` composes several logs (personal, project, org) and routes writes by
`level` and `namespace`. Recall fans out over mounts and tags results with `mount.id`.

Conformance test suite (`@ynm/store/testing`) runs the same behaviour tests against every
provider, including concurrent-append loss detection.

## Alternatives considered

- One provider with pluggable "location" strings (ACME). Rejected: pushes git specifics upward.
- Making git-notes the only provider. Rejected: hosting without git and unit testing need others,
  and the interface is small.

## Decided

- git notes is the default provider everywhere, including the hosted central store, which is the
  git-notes provider over a bare repo (2026-09-28). It is the default because it solves
  replication (fetch, merge, push) and audit (ref history) for nothing. sqlite is the scale escape
  hatch for hosted stores; switching providers changes nothing above layer 2.
- Every provider must pass the shared conformance suite before it can be mounted.

## Consequences

- Sync is provider-specific; `service.sync` no-ops for providers without it.
- Index (ADR-005) subscribes to `append` results, so incremental indexing works for all providers.
- A local clone syncing with a hosted store is just git remote traffic; the hosted server process
  is the single writer on that repo.
- `scan` filters by shard prefix only; anything finer is the index's job (default, 2026-09-28).
- `WorkingStore` lives in the same `store` package (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- (none yet)
- 2026-09-29 (M5): `SqliteLog` (`node:sqlite`, WAL, busy timeout) passes the same conformance
  suite as git-notes, fs and memory, including cross-process concurrent writers. Shards are rows
  with a revision counter so index freshness works unchanged; `purge` bumps the touched shards.
  It is selectable as the default provider or per mount (`provider: "sqlite"`), and the hosted
  HTTP suite runs unchanged on git-notes and sqlite. No sync: it is the scale escape hatch and
  the git-free option, not a replicated store.
