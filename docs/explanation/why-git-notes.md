# Why git notes

ynm keeps memory in git notes: refs under `refs/notes/ynm/`, next to the code, in the same
repository, moved by the same `git fetch` and `git push`. This page explains why, what that
buys you, and what it costs. [ADR-003](../adr/003-git-notes-layout.md) records the layout and
[ADR-009](../adr/009-hosting-and-bootstrap.md) the hosting choices that follow from it.

## The problem

A coding agent's memory is only useful if it is there next time, for you and for the people you
work with. The usual answers are a vector database on someone's server, or a markdown file in
the repository. The first puts the team's knowledge somewhere else, behind another account and
another backup. The second puts it in the working tree, where every memory is a diff in a pull
request and every agent write is a merge conflict waiting to happen.

What a project already has is a git repository that everyone clones, that has a remote, that is
backed up, and that has an access model the team already trusts. The question was whether memory
could live there without touching the code.

## What git notes are

A git note is a blob attached to an object id, kept on its own ref. Notes do not change the
object they annotate, do not appear in the working tree, and are not fetched or pushed unless
you ask for their refs. `git log --notes` can show them; nothing else notices them.

That is almost exactly the shape memory needs: data that belongs to the repository, travels with
it on request, and never gets in the way of the code.

## How ynm uses them

**One ref per shard.** Each combination of level, namespace, type and month gets its own ref,
such as `refs/notes/ynm/shared/common/semantic/2026-09`. A shard holds one note: every record for
that bucket, one JSON object per line. Months keep any one blob small and let old shards go
quiet.

**One anchor.** Every note hangs off the repository's root commit. It exists in every clone,
on every branch, and no rebase, amend or squash touches it. Notes attached to feature commits,
which is what earlier tools did, are silently lost when those commits are rewritten.

**Append-only lines.** A record is never edited. Changing a memory appends a `supersede`;
forgetting appends a `tombstone`. Because every line is independent, two clones that both wrote
can be merged with git's own `cat_sort_uniq` strategy: concatenate, sort, drop duplicate lines.
There is no conflict to resolve, ever.

**History is the audit log.** Every append is a commit on the shard's ref. `git log` on a shard
is the list of writes, and any earlier state can be recovered from git's object store.

## What you get

- **No new infrastructure.** The repository you already have is the store. Its remote is the
  sync server. Its hosting, backups and permissions are the memory's.
- **Nothing in the working tree.** No files to review, no merge conflicts in pull requests,
  no noise in `git status`. `ynm init` changes no branch, tag, commit or tracked file.
- **Conflict-free sync.** Any number of clones can write offline and sync later; the merge is
  mechanical.
- **Opt-in visibility.** Teammates who never run `ynm init` never fetch the refs and never see
  them.
- **A personal store with the same machinery.** Your personal memory is a bare repository in
  `~/.ynm/store.git` using the identical layout, so the same code reads both.

## What it costs

- **Reads need an index.** Reading notes means spawning git. ynm reads every shard in two
  processes, but recall cannot scan git on every query, so a SQLite index sits beside the store
  and rebuilds itself when the refs move. The index is derived and never shared.
- **Writes are several git calls.** An append builds a commit with plumbing so it can
  compare-and-swap the ref: about seven git processes. Fine for an agent writing a fact; slow
  for bulk loads, which batch.
- **Storage only grows.** Append-only means every change adds a line. Git's delta compression
  keeps that close to the size of the new lines, and `ynm purge` exists for the rare case where
  something must really go, but the log does not shrink on its own.
- **Forges do not protect notes refs.** Anyone who can push to the repository can push notes.
  Where that matters, the hosted service becomes the single writer and clients never push
  directly.
- **Many writers on one shard contend.** Pushes retry when the remote moved. A store with many
  concurrent writers is the signal to move it to the hosted topology.

## Why not something else

A database would give faster reads and no git dependency, at the price of a server to run and a
second place the team's knowledge lives. A file in the repository would be simpler still, but it
turns memory into code review. Custom refs with one commit per memory would avoid notes, but
lose the line-merge property and put thousands of refs on the forge.

Git notes are the one place already shared, already backed up, and out of the way. The rest of
ynm (the index, the fold, the hosted service) exists to pay for their costs.

## Where this leaves you

For most projects, run `ynm init` once in the repository and memory rides along with every
fetch and push from then on:

```bash
ynm init
```

If you would rather keep memory out of the code repository entirely, the same layout works in a
dedicated bare repository, on disk or on a forge, mounted alongside. See
[Personal and distributed memory](personal-and-distributed.md) for where each kind of memory
goes.
