# Record format reference

The on-disk format: one JSON object per line, one line per change, never edited. A memory is
the fold of every record that shares its `memoryId`. The field table and the lists of ops and
relations are generated from the record schema by `pnpm docs:gen`.
[ADR-002](../adr/002-record-format.md) and [ADR-003](../adr/003-git-notes-layout.md) record the
decisions.

## Record fields

<!-- gen:record-fields -->
| Field | Type | Required | Description |
|---|---|---|---|
| `v` | `1` | yes | Record schema version |
| `id` | string | yes | Record id; sortable by time |
| `memoryId` | string | yes | Memory this record belongs to; equals id for the first record |
| `op` | `create` \| `supersede` \| `annotate` \| `tombstone` \| `purge-marker` \| `snapshot` | yes | What the record does to its memory (see the list below) |
| `type` | `working` \| `episodic` \| `semantic` \| `procedural` \| `reflective` \| `reference` | yes | Memory type (ADR-001) |
| `level` | `personal` \| `distributed` | yes | personal never leaves the user's store by default |
| `namespace` | string (max 512) | yes | Hierarchical namespace, e.g. common, user/david, org/eyelock/project/ynm, session/<id> |
| `subject` | string (max 200) |  | Entity or topic key, e.g. entity:git-notes |
| `tags` | array of string (max 64) |  | Free-form tags |
| `content` | string (max 65536) |  | Markdown; the memory itself |
| `summary` | string (max 280) |  | One line for index.md and pinned context |
| `data` | object |  | Optional structured payload for typed memories |
| `dataSchema` | string (max 100) |  | Name of the expected shape of data |
| `importance` | number 0..1 |  | 0..1; writer-supplied default 0.5 |
| `confidence` | number 0..1 |  | 0..1 |
| `pinned` | boolean |  | Always included in the context block |
| `needsReview` | boolean |  | Flagged by a low-confidence model decision |
| `recordedAt` | date-time | yes | Transaction time |
| `validFrom` | date-time |  | Event time the memory became true |
| `validTo` | date-time or null |  | Event time it stopped being true |
| `ttl` | string |  | Working memory only |
| `provenance` | object | yes | Where the record came from (ADR-002) |
| `provenance.actor` | string | yes | Who wrote it, e.g. agent:claude-code or user:david |
| `provenance.session` | string |  | Session id |
| `provenance.source` | string |  | Source reference: URL, file, ticket, tool call |
| `provenance.tool` | string |  | Tool or command that produced the record |
| `links` | array of object |  | Typed links to other memories |
| `links[].rel` | `supersedes` \| `derives-from` \| `contradicts` \| `supports` \| `about` \| `in-session` | yes |  |
| `links[].to` | string | yes | memoryId of the target |
| `reason` | string (max 1000) |  | Why, for tombstone, purge-marker and annotate |
<!-- /gen:record-fields -->

Unknown fields are rejected. `id` and `memoryId` are ULIDs: 26 characters, Crockford base 32,
sortable by creation time. `recordedAt` is stamped by the writer in UTC. `ttl` is an ISO 8601
duration such as `PT2H` or `P7D`.

Validation rules beyond the types:

- `create` and `supersede` must carry `content`.
- `create` must have `memoryId` equal to `id`.
- `supersede` must carry a `supersedes` link.
- `snapshot` must carry `data`.
- A `working` record must have a namespace under `session/`.

A reader skips, and reports, any line that is not valid JSON or fails validation; a bad line is
never fatal.

## Ops

<!-- gen:ops -->
- `create`
- `supersede`
- `annotate`
- `tombstone`
- `purge-marker`
- `snapshot`
<!-- /gen:ops -->

| Op | Effect on the folded memory |
|---|---|
| `create` | Starts the memory. A second `create` for the same memory, a merge artefact, adds its tags and links only |
| `supersede` | Replaces `content`, `summary`, `data`, `type`, `namespace`; sets `subject`, `importance`, `confidence`, `pinned`, `needsReview` when given; adds tags and links; revives a tombstoned memory |
| `annotate` | Adds tags and links; sets `subject`, `importance`, `confidence`, `pinned`, `needsReview` when given. Content is unchanged |
| `tombstone` | Hides the memory from recall, context and the wiki. History stays |
| `purge-marker` | Records that a purge removed lines. No state change |
| `snapshot` | The folded state of a shard at `recordedAt`; a reader may start from it and apply only later records |

## Fold order

Records are applied in `recordedAt` order, ties broken by `id`, so the result does not depend
on the order lines appear in a shard or on which clone merged first. A record that sorts before
its memory's base (the first `create` or `supersede`) still counts as a version and contributes
tags and links, but the base wins on every field it sets. A record whose memory has no base at
all is an orphan: kept, reported, not shown.

The folded memory carries `createdAt` (first record), `updatedAt` (latest record), `versions`
(records folded), `tombstoned` and `current` (the record that holds the current content).

## Relations

<!-- gen:relations -->
- `supersedes`
- `derives-from`
- `contradicts`
- `supports`
- `about`
- `in-session`
<!-- /gen:relations -->

| Relation | Written by |
|---|---|
| `supersedes` | every `supersede` record, pointing at the memory it replaces |
| `derives-from` | `promote` (the copy points at the personal original), dedupe merges, reflections (pointing at their episodes) |
| `contradicts` | the contradict pass, on both memories |
| `supports`, `about`, `in-session` | callers, through `--links` |

## Where records live (git-notes provider)

Each record is appended to one shard, chosen from the record itself:

```text
refs/notes/ynm/<personal|shared>/<namespace>/<type>/<yyyy-mm>
```

| Part | Value |
|---|---|
| `personal` or `shared` | the record's `level`: `personal` for personal, `shared` for distributed |
| `<namespace>` | the namespace, each `/`-separated segment a ref path component |
| `<type>` | the memory type |
| `<yyyy-mm>` | the UTC month of the record's `recordedAt` |

So a memory created in September and superseded in October has records in two shards; the fold
spans them. Personal refs exist only in the personal store (`~/.ynm/store.git`); project and
shared stores hold only `shared` refs.

Each shard ref points at a notes commit whose tree holds one note blob, the shard's JSONL, at
the anchor's path. Every append is a new commit whose parent is the previous one, so
`git log <ref>` is the write history of the shard. Commit messages have the form
`ynm: <n> record(s) <level>/<namespace>/<type>/<yyyy-mm>`.

Sync fetches remote shards into `refs/notes/ynm-remote/<remote>/shared/...` and merges them with
`git notes merge -s cat_sort_uniq`. It never fetches into `refs/notes/ynm/*` directly.

## The anchor

Every note hangs off one commit, the anchor: the repository's root commit. When a repository has
several parentless commits, the oldest by committer date wins, ignoring commits reachable only
from `refs/notes/*`. `ynm init` records it as `anchor` in `.ynm/config.json` so every clone
agrees; setting `anchor` by hand to any stable commit also works. `ynm init --bare` and the
personal store create one empty root commit to serve as the anchor, and the personal store's
anchor is recomputed on every open. The anchor object need not be present (shallow clones work);
only its id is used.

## Namespaces

`/`-separated segments. Each segment starts with `[a-z0-9]` and contains only `[a-z0-9._-]`;
no segment may contain `..` or end in `.lock`. At most 512 characters. Well-known namespaces:
`common` (the default for distributed memory), `user/<id>` (the default for personal memory)
and `session/<id>` (required for working memory). Session ids are lowercased and every run of
characters outside `[a-z0-9._-]` becomes `-`.

## Export format

`ynm export` writes records in this format, one per line, including history and tombstones.
`ynm import` reads the same format and routes each record to a mount by its `level`; ids are
kept.
