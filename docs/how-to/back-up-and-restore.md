# Back up and restore

Goal: keep a copy of your memory you can restore from. A git-notes store is a git repository, so
a backup is a bundle; a SQLite store is a file. The index is derived data and never needs
backing up: delete it and the next request rebuilds it. Tutorial 11 walks through a restore.

## A project's shared memory

Everything is under `refs/notes/ynm/` in the project repository:

```bash
git bundle create /backups/project-$(date +%F).bundle --all
```

`--all` includes the notes refs along with your branches. To restore into a fresh clone, clone
the bundle and then fetch the notes, which a plain clone leaves behind, and run `ynm init`:

```bash
git clone /backups/project-2026-09-29.bundle restored
git -C restored fetch /backups/project-2026-09-29.bundle 'refs/notes/ynm/*:refs/notes/ynm/*'
cd restored && ynm init
```

## Your personal store

It is a bare repository at `~/.ynm/store.git` (or under `$YNM_HOME`). It is private, so back it
up somewhere other people cannot read, never alongside a project's bundle:

```bash
git -C ~/.ynm/store.git bundle create ~/backups/ynm-personal-$(date +%F).bundle --all
git clone --mirror ~/backups/ynm-personal-2026-09-29.bundle ~/.ynm/store.git   # restore
```

Restore only into an empty location.

## A hosted store

The server's repository, `/data/store.git` in the container image:

```bash
git -C /data/store.git bundle create /backups/ynm-$(date +%F).bundle --all
git clone --mirror /backups/ynm-2026-09-29.bundle restored.git   # restore
```

A mirror on a forge (`git push --mirror`) is a continuous backup. Point a new server at the
restored repository, or copy it to `/data/store.git` before the container starts.

## A SQLite store

Copy `store.sqlite` while nothing writes to it, or checkpoint first so the write-ahead log is
folded in: run `PRAGMA wal_checkpoint(TRUNCATE)` against the file, or copy `store.sqlite` together
with its `-wal` file. Restore by putting the file back at the same path.

## As portable JSONL

Independent of the provider, `ynm export` writes every record, history and tombstones included,
and `ynm import` reads it back into any store with ids preserved:

```bash
ynm export > memory.jsonl
ynm import memory.jsonl
```

Use it to move between providers or machines. It backs up one store at a time; pass `--mount`
for a single mount. Purged records are gone from it, by design.
