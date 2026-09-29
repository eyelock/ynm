# ADR-010: Compiled markdown wiki as a derived view

Status: accepted (2026-09-29)
Satisfies: FR-19, FR-9

## Context

Karpathy's LLM Wiki: raw sources (immutable), a wiki of LLM-written markdown pages with `index.md`
(catalog) and `log.md` (append-only chronology), and a schema file (CLAUDE.md) describing the
conventions; operations ingest, query, lint. Its value is that the knowledge is compiled once and
kept current, and that humans can read and grep it. Its weaknesses (from the comment threads): it is
lossy compression, has no benchmarks, and needs real retrieval past a few hundred pages. Google's
Open Knowledge Format (OKF) is a markdown-with-frontmatter spec for the same layout.

## Decision

The wiki is a **projection**, generated from the folded memory state, never the source of truth,
and ships in v1. Pages:

- `index.md`: one line per non-tombstoned memory grouped by namespace and type, using `summary`.
  It is the full catalog, also served as `memory://<mount>/wiki/index.md`. The pinned context
  block is a separately ranked set packed to a token budget, not a copy of `index.md`.
- `log.md`: `## [date] <op> | <summary>` per record, newest last; derived from the log itself.
- `memories/<id>.md`: one page per memory; the frontmatter holds the memoryId.
- `entities/<subject>.md` and `topics/<tag>.md`: pages assembled from the memories sharing that
  subject or tag, with the reflective memory (if any) at the top and episodic entries below.
- Frontmatter follows OKF (`type` required) so other OKF-aware tools can read it.

The projection is produced by a pure generator (fold → pages) and written through a `WikiTarget`
seam, mirroring the store and index seams:

```ts
interface WikiTarget { write(pages: WikiPage[]): Promise<void>; read(path: string): Promise<string | null>; list(): Promise<string[]> }
```

Two targets exist: **directory** (default, `.ynm/wiki/` gitignored, or any path such as an
Obsidian vault) and **orphan branch** `ynm/wiki` for teams that want it browsable on a forge.
`ynm wiki build [--target orphan-branch]` writes them, as does the dream pass. Independently of
any target, the MCP resource `memory://{mount}/wiki/{path}` serves pages generated on demand, so
a client can read the wiki with nothing on disk.

Edits made to wiki files by hand are **not** read back automatically. `ynm wiki ingest <page>`
turns an edited memory page into a `supersede` record, mirroring Karpathy's "file answers back
into the wiki" but through the log.

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

## Open questions

None.

## History

- 2026-09-29 (M4): generator, directory and orphan-branch targets, `wiki build` / `wiki ingest`
  and the on-demand wiki resource shipped with golden-file tests.
