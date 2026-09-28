# ADR-003: Refs, anchors, sharding, writes, merging

Status: draft
Satisfies: FR-15, FR-16, NFR-1, NFR-2, NFR-3, NFR-8

## Context

Facts about git notes that drive this decision (verified against git 2.54 and its source):

- A note attaches to an object id; the object must exist. Notes on feature commits are lost on
  rebase, amend and server-side squash unless `notes.rewriteRef` is configured, and never for
  server-side rewrites. ACME anchored to HEAD and suffered exactly this.
- `git notes add` does `update-ref` with no expected old value: no compare-and-swap. Concurrent
  local writers can lose updates.
- `git notes merge -s cat_sort_uniq` merges line-oriented notes without conflicts.
- Notes do not keep their annotated objects alive; `git gc` can prune an unreachable anchor and
  `git notes prune` then removes its notes.
- Reading many notes must use batched plumbing (`ls-tree`, `cat-file --batch`), never one process
  per note.

## Decision (current position)

**Refs.** One notes ref per (level, namespace, type, time bucket):

```
refs/notes/ynm/personal/<namespace>/<type>/<yyyy-mm>
refs/notes/ynm/shared/<namespace>/<type>/<yyyy-mm>
```

Namespace path separators map to `-` inside the ref name. `personal/*` refs exist only in the
user's own store (`~/.ynm/store.git`), never in a project or org repo (ADR-007). Time buckets bound the size of any single blob (NFR-3) and make old
buckets effectively immutable, which suits consolidation snapshots.

**Anchor (agreed 2026-09-28).** Every note in a ref is attached to the **root commit** of the
repository. It always exists, is reachable from every branch, and no rebase touches it. The root
commit is never rewritten by ynm; it is only the address the notes hang off, like a table name.

Selection rule: `git rev-list --max-parents=0 --all`, oldest by committer date if there are
several (repos built from merges or subtree imports can have more than one). The chosen SHA is
written to `.ynm/config.json` as `anchor` so every clone agrees. For a dedicated memory repo
(`ynm init --bare`) we create exactly one empty root commit. If a repo has no commits yet,
`ynm init` creates one.

Shallow clones (CI, depth 1) may not have the root commit object. That is fine: the plumbing
writer and the batched reader only use the SHA as a tree path. Only the `git notes` porcelain and
`git notes prune` require the object, and ynm uses neither. `ynm doctor` reports a missing
anchor object as informational.

Consequence: one note blob per ref, containing all records of that bucket as JSONL. The ref
namespace, not the anchor, is the partition key.

**History is the transaction log.** Every append is a new commit on the shard ref whose parent is
the previous notes commit, so `git log <ref>` is the write history and `git show <commit>:<path>`
recovers the blob at any point. The blob itself is also append-only (ADR-002). Consolidation only
appends records, so its inputs always remain to re-run it from. The fold (current state) is derived
and cached in the index; it is never stored as the truth.

**Snapshots.** The dream pass may append a `snapshot` record (ADR-002) holding the folded state of
a shard at that moment. Readers can bootstrap from the last snapshot plus the tail instead of
folding from the first record: the classic log-plus-checkpoint pattern.

**Size.** Blob versions are delta-compressed in packfiles, so history costs about the size of the
appended lines, not records squared. At 1 KB per record: 100 records/day is roughly 36 MB raw per
year, 10 to 15 MB on disk; 1000/day is roughly 365 MB raw, 100 to 150 MB on disk. Levers if a
store grows large: `ynm compact` rolls a year of monthly shards for one namespace and type into
one yearly ref (snapshot plus tail) and deletes the monthly refs; per-shard ref history can be
truncated without touching records; purge; the personal store is its own bare repo so it never
bloats a project clone; the hosted topology can use the sqlite provider.

**Writes.** The git-notes provider does not shell out to `git notes add`. It builds the commit with
plumbing so it can compare-and-swap:

1. Take a per-repo lockfile (`.git/ynm.lock`, O_EXCL, stale-PID detection; copy from ACME fs).
2. Read the ref tip `old`; read the existing note blob (may be absent).
3. Append the line(s); `hash-object -w` the new blob; `mktree` with the anchor path (respecting
   fanout: write the flat 40-hex path; git reads either); `commit-tree -p old`.
4. `update-ref <ref> <new> <old>`; on failure re-read and retry (bounded).
5. Release the lock; notify the index of the appended records.

Commit messages are structured (`ynm: 3 records project/ynm semantic 2026-09`) so the ref's
`git log` reads as an audit trail.

**Reads.** `for-each-ref refs/notes/ynm/<prefix>` to enumerate shards, then one
`cat-file --batch` over `<ref>:<anchor-path>` for every shard. Whole-store load is two processes,
not N.

**Sync (shared refs only).** For each shard: fetch remote into `refs/ynm-remote/<same path>`,
`git notes --ref=<local> merge -s cat_sort_uniq <remote-tmp>`, push, retry on non-fast-forward.
Fetch refspecs are never forced into the local notes refs (ACME's `+refs/notes/*:refs/notes/*`
silently discarded unpushed local notes).

**Never** run `git notes prune` on `refs/notes/ynm/*`; `ynm doctor` warns if the anchor is
unreachable.

## Alternatives considered

- **Empty tree as anchor** (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`). Always exists even in an
  empty repo. Kept as fallback for repos with no commits, but the root commit is more obviously
  "this repo's" and shows in `git log --notes`.
- **Per-record anchor blobs** (`hash-object -w` of the memory id). Gives one note per memory and
  native `git notes show <id>`, but blobs are unreachable and get gc'd; keeping them alive needs a
  second ref or non-note tree entries. Too clever; revisit only if one-blob-per-shard proves too
  coarse.
- **Fake object ids as note paths** (git-meta style). Works with plumbing but `git notes prune`
  destroys it and tooling gets confused. Rejected.
- **Custom refs with commit-per-record** (git-bug style, `refs/ynm/<id>`). Loses `notes merge`
  and the JSONL-line merge property; one ref per memory does not scale on forges. Rejected.
- **Attach episodic memories to the commits they concern** (ACME's model). Optional future
  feature via an `about: commit:<sha>` link, not as the storage anchor.

## Consequences

- A memory's shard is determined by its first record's `recordedAt` month. Supersede records go in
  the current month's shard; the fold spans shards. The index (ADR-005) maps memoryId to shards.
- Shard count grows with namespaces × types × months. Enumerating refs is cheap; a store with 100
  refs is fine. `ynm compact` can roll old buckets of one namespace/type into a yearly ref.
- Remote hosting on a forge works with any provider because only `refs/notes/*` push access is
  required. No forge protects these refs; the hosted topology (ADR-009) is the answer where that
  matters.

## Decided

- Root commit as anchor, with the selection rule above (2026-09-28).
- Month buckets: deterministic across clones, which matters for merging. Daily would mean
  thousands of refs a year; yearly would mean one blob rewritten all year.
- Ref history is the transaction log and is never rewritten by normal operation. Only
  `ynm purge --forget-history` drops it, as a separate audited command.
- `anchor` in `.ynm/config.json` may override the root commit with any stable commit SHA, for
  repos that want the notes visibly separate in `git log --notes` (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- (none yet)
