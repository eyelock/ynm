# ADR-010: Compiled markdown wiki as a derived view

Status: draft
Satisfies: FR-19, FR-9

## Context

Karpathy's LLM Wiki: raw sources (immutable), a wiki of LLM-written markdown pages with `index.md`
(catalog) and `log.md` (append-only chronology), and a schema file (CLAUDE.md) describing the
conventions; operations ingest, query, lint. Its value is that the knowledge is compiled once and
kept current, and that humans can read and grep it. Its weaknesses (from the comment threads): it is
lossy compression, has no benchmarks, and needs real retrieval past a few hundred pages. Google's
Open Knowledge Format (OKF) is a markdown-with-frontmatter spec for the same layout.

## Decision (current position)

The wiki is a **projection**, generated from the folded memory state, never the source of truth:

- `index.md`: one line per non-tombstoned memory grouped by namespace and type, using `summary`.
  Also the exact content returned by `memory://<mount>/wiki/index.md` and the basis of the pinned
  context block.
- `log.md`: `## [date] <op> | <summary>` per record, newest last; derived from the log itself.
- `entities/<subject>.md` and `topics/<tag>.md`: pages assembled from the memories sharing that
  subject or tag, with the reflective memory (if any) at the top and episodic entries below.
- Frontmatter follows OKF (`type` required) so other OKF-aware tools can read it.

The projection is produced by a pure generator (fold → pages) and written through a `WikiTarget`
seam, mirroring the store and index seams:

```ts
interface WikiTarget { write(pages: WikiPage[]): Promise<void>; read(path: string): Promise<string | null>; list(): Promise<string[]> }
```

Implementations: **directory** (default, `.ynm/wiki/` gitignored, or any path such as an
Obsidian vault), **orphan branch** `ynm/wiki` for teams that want it browsable on a forge,
**notes-tree** (non-note files inside the ynm notes tree, invisible to normal tools but carried
with the refs), and **resources-only** (nothing on disk; pages served through
`memory://<mount>/wiki/*`). Written by `ynm wiki build` and by the dream pass.

Edits made to wiki files by hand are **not** read back automatically. `ynm wiki ingest <file>`
turns an edited page into `supersede` records, mirroring Karpathy's "file answers back into the
wiki" but through the log.

## Alternatives considered

- Wiki as the primary store, notes as a backup (pure Karpathy). Rejected: merging free-form
  markdown across clones has no `cat_sort_uniq`; the log model gives identity, time and provenance.
- No wiki at all; rely on the index. Rejected: human readability and the index.md pinned tier are
  cheap and useful.
- Storing wiki pages inside the notes tree as non-note files. Possible (git preserves them), but
  invisible to normal tools; kept as an idea if the orphan branch proves awkward.

## Consequences

- The wiki generator is a pure function of the fold; it is tested with golden files.
- `lint` in Karpathy's sense is the dream pass (ADR-006), reporting orphans, contradictions and
  stale claims into `ynm status`.

## Decided

- The wiki is a derived projection behind a `WikiTarget` seam; directory is the default target,
  orphan branch the first alternative (2026-09-28). In v1.
- The pinned context block is a separately ranked set packed to a token budget; `index.md` is
  the full catalog (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M4): generator and two targets shipped with golden-file tests: `index.md`,
  `log.md`, `memories/<id>.md` (one page per memory, frontmatter holds the memoryId), entity pages
  per subject with the reflection first, topic pages per tag. `ynm wiki build [--target
  orphan-branch]` and `ynm wiki ingest <page>` (an edited memory page becomes a supersede).
  MCP resource `memory://{mount}/wiki/{path}` serves pages generated on demand.
