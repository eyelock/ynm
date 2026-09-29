# Choose the SQLite provider

Goal: keep a store in a single SQLite file instead of git notes. Choose it for a store that is
only yours, or for a hosted store where one process is the single writer and nobody clones the
repository. Tutorial 11 walks through it once.

## What changes

| | git-notes (default) | sqlite |
|---|---|---|
| Storage | records as git notes in a repository | one file, `store.sqlite` |
| Sharing | any git remote; `ynm sync` merges | none; `ynm sync` has nothing to send |
| History | a git commit per write | the same append-only record log, held in SQLite |
| Backup | `git bundle`, a mirror on a forge | copy the file |

The record format, ranking and the wiki are the same. Personal and distributed memory both
follow the setting, because the provider is per configuration, not per level.

## Turn it on

Set the provider before the first `ynm init` in a repository, in its `.ynm/config.json`:

```json
{ "provider": "sqlite" }
```

Then run `ynm init`. It keeps your setting and adds the anchor. Set it in `~/.ynm/config.json`
instead to make it the default for every project on the machine, personal store included.

The file lands at `.ynm/store-sqlite/store.sqlite` in the project, and the personal store at
`~/.ynm/store-sqlite/store.sqlite`. `ynm status` shows `sqlite` for each mount, and `ynm doctor`
reports the file path and its record count.

## For a hosted store

Put `{"provider": "sqlite"}` in the served repository's `.ynm/config.json`, as described in
[Operate a hosted store](operate-a-hosted-store.md). The server is the only writer, so the
git write path is unneeded. Back up the file after a checkpoint: run
`PRAGMA wal_checkpoint(TRUNCATE)` against it, or copy `store.sqlite` together with its `-wal`
file. See [Back up and restore](back-up-and-restore.md).

## Switching an existing store

There is no in-place conversion. Export from the old store and import into the new one:

```bash
ynm export > memory.jsonl
```

Change the provider in a fresh location, run `ynm init`, then `ynm import memory.jsonl`. Ids and
history come across. Export is per store and includes tombstones and purge markers.
