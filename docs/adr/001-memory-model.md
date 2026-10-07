# ADR-001: Memory types, levels and namespaces

Status: accepted (2026-09-29)
Satisfies: FR-1, FR-2, FR-6, NFR-5

## Context

Production agent memory systems converge on the CoALA taxonomy (working, episodic, semantic,
procedural) plus two additions that appear in nearly every product: reflective (derived insights,
beliefs, summaries) and reference (pointers to external sources). Scope is a separate axis in all of
them: Mem0 uses user/agent/app/run ids, LangGraph uses hierarchical namespaces, Claude Code uses
managed/user/project/local tiers. The predecessor project had one axis only (entry type) and one implicit scope (the
repo), which made "personal vs shared" impossible.

## Decision

Three orthogonal fields on every record:

1. **type**, one of: `working`, `episodic`, `semantic`, `procedural`, `reflective`, `reference`.
2. **level**, one of: `personal`, `distributed`. The level is binary: audience finer than that is a
   namespace convention plus which remote a store syncs to; the schema does not enforce it. Level
   is fixed at write time and determines which store and which refs the record can ever live on.
   Moving a record from personal to distributed is an explicit copy that creates a new record with
   a `derives-from` link.
3. **namespace**, a `/`-separated path of unbounded depth, such as `common`, `user/david`,
   `agent/reviewer`, `org/eyelock/team/platform/project/ynm`, `session/<id>`. Segments are
   `[a-z0-9][a-z0-9._-]*` (no leading dot, no `..`, no `.lock` suffix, so every segment is a
   valid git ref component; ADR-003). Namespaces are hierarchical so recall can filter by prefix, and they are the
   only grouping mechanism above the record: team, project, client, org are all namespaces, not
   levels. A record has exactly one namespace.

   Well-known namespaces: `common` is the default for distributed records (shared by everyone
   using that store); `user/<id>` is the default for personal records; `session/<id>` is required
   for working memory. Anything else is convention, and a store may publish its conventions as a
   procedural memory in `common`.

Plus two free-form grouping fields:

- **subject**: an optional entity or topic key (`entity:git-notes`, `topic:release-process`) so
  episodic memories about a recurring theme can be recalled together and consolidated as a series.
  It is a field, not a link, so it can be filtered cheaply.
- **tags**: string list.

Working memory is `type: working`, always `namespace: session/<id>`, always carries a TTL, and is
the only type that a consolidation pass may promote into another type.

## Alternatives considered

- Three levels (`personal`, `project`, `organisation`) instead of two. Rejected for now: "project"
  and "organisation" are namespaces within `distributed`; the privacy boundary is binary.
- Type as free-form string. Rejected: the six types drive TTL, ranking and consolidation rules.
- A single "kind" enum mixing type and scope, as the predecessor project did. Rejected: it cannot express
  "a personal procedural memory about project X".

## Consequences

- Every tool and CLI command takes `type`, `level`, `namespace` filters.
- Ranking weights differ per type (recency matters most for episodic, least for procedural).
- `level` must be enforced by the store, not just the schema: a `personal` record cannot be written
  to a distributed ref.

## Open questions

None.

## History

No addenda were recorded during the build.
