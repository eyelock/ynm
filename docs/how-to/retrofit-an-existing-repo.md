# Retrofit an existing repository

Goal: give a repository that already has history, branches and a team a shared ynm memory,
without disturbing any of it. Background: [ADR-009](../adr/009-hosting-and-bootstrap.md).

## Run init

From inside the repository:

```bash
ynm init
```

`ynm init` changes no branch, tag or commit, and no tracked file except a `.gitignore` that gains
two lines. It does five things:

- writes `.ynm/config.json`, which records the anchor (the repository's root commit) and is the
  one file worth committing, so teammates share the anchor and any mounts or redaction settings;
- adds a fetch refspec for `refs/notes/ynm/shared/*` to `remote.origin` in
  `.git/config` (pass `--remote <name>` to use another remote; without the remote it prints a
  note and you re-run `init` after adding it);
- installs a `pre-push` hook that runs `ynm sync --quiet`, unless you pass `--no-hooks` or set
  `"hooks": false` in your config;
- adds `.ynm/wiki/` and `.ynm/index/` to `.gitignore` when they are not already ignored, and says
  so in a note;
- builds the search index under `.ynm/index/`.

Memory itself appears only when someone writes it, as refs under `refs/notes/ynm/`. Teammates who
have not run `ynm init` see nothing and are not affected.

## What to commit

Commit `.ynm/config.json` and the `.gitignore` change. `init` added the derived directories to it:

```text
.ynm/wiki/
.ynm/index/
```

## Other notes and existing tooling

ynm lives in its own ref namespace, so `refs/notes/commits` and any other notes are untouched.
The refspecs are local to each clone: `ynm doctor` reports a clone where they are missing, and
`ynm init` repairs it.

## Special repositories

- **Several root commits.** ynm picks the oldest by date and records it in config. To choose a
  different one, pass it: `ynm init --anchor <sha>`.
- **Shallow clones.** They work, because the anchor is only a path in the notes tree, not
  something ynm needs to read. If the root commit is not in the shallow history, pass it with
  `--anchor <sha>`.
- **Monorepos.** Every project shares the root commit. Separate them by namespace, for example
  `--namespace org/eyelock/project/api`; recall filters by namespace prefix.
- **Forks and mirrors.** Notes do not follow a fork unless the fetch refspec is configured there.
  Run `ynm init` in the fork and let `ynm doctor` confirm the refspecs.
- **A worktree.** ynm finds the main repository and shares one store across all worktrees.

## When many people write at once

Every push to one shard can race. `ynm sync` retries after a fresh fetch, and the count shows in
its `retries` field. If retries stay high for a busy store, move that store to the
[hosted single-writer topology](operate-a-hosted-store.md) rather than fighting it.

## Undo

Remove the hook (`.git/hooks/pre-push`), the `remote.origin.fetch`
line that mentions `refs/notes/ynm`, and `.ynm/`. Memory written so far stays in
`refs/notes/ynm/`; delete those refs only if you mean to discard it.
