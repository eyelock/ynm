# Doctor and Maintenance

Check a setup, break it on purpose and watch `ynm doctor` say what is wrong, rebuild the search
index, try the SQLite provider, and take a backup you can restore from.

## Prerequisites

`ynm` is on your PATH. Prepare the sandbox, a personal store, a bare remote, and a project
clone with `origin` pointing at it, ynm initialised and one shared memory written:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
export YNM_NO_CLAUDE_CLI=1
cd /tmp/ynm-tutorial
ynm init --personal
git init -q --bare -b main remote.git
git init -q -b main project
git -C /tmp/ynm-tutorial/project remote add origin /tmp/ynm-tutorial/remote.git
git -C /tmp/ynm-tutorial/project -c user.name=tutorial -c user.email=tutorial@example.com commit -q --allow-empty -m "first commit"
cd project
ynm init
ynm remember --type semantic --level distributed --content "Backups are taken with git bundle."
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git`, the `initialised` report with
its `refspecs`, `hooks` and `.gitignore` note lines, and `remembered <26-character id> in project`.

## A healthy doctor

```bash
ynm doctor
```

Expected: every line starts with `ok`, and the command exits 0. The lines, in order: git is
available, the config file, the `personal` mount and the `project` mount (each with a JSON blob
of its repository, anchor, number of shards and `"badLines":0`), the project anchor, the shared
fetch refspec, that personal refs are never pushed, that no personal refs are in the
project repo, and the pre-push hook.

```text
ok    shared fetch refspec: +refs/notes/ynm/shared/*:refs/notes/ynm-remote/origin/shared/*
ok    personal refs never pushed: no personal refspecs in remote config (ADR-007)
ok    no personal refs in project repo: ok (ADR-007)
ok    pre-push hook: <project path>/.git/hooks/pre-push
```

## Break it

Delete the hook and take out the notes fetch refspec, the two things `ynm init` added to make
sync work:

```bash
rm .git/hooks/pre-push
git config --unset remote.origin.fetch '^\+refs/notes/ynm/'
ynm doctor || echo "exit $?"
```

Expected: the same lines as before, except two. A failure, and a warning:

```text
FAIL  shared fetch refspec: missing; run `ynm init`
warn  pre-push hook: not installed
exit 1
```

`FAIL` makes doctor exit 1; `warn` alone does not. The fix is what the message says. `init` is
safe to repeat, and it only adds what is missing:

```bash
ynm init
ynm doctor
```

Expected: an `initialised` report with the config marked `(unchanged)` and the `refspecs` and
`hooks` lines it restored, then a doctor run that is all `ok` again.

## The index

Search runs on an index, a SQLite file derived from the log. It is a cache; nothing in it is
the only copy of anything. `ynm status` shows whether it is current:

```bash
ynm status
```

Expected: the config path, then two mounts, each ending `index fresh (<n>)` where n is the
number of memories indexed: `0` for `personal` and `1` for `project`.

Delete the project's index. The memory is untouched, and status notices:

```bash
rm -rf .ynm/index
ynm status
```

Expected: the `project` line now says `index stale (0)`; `personal` is unchanged.

Rebuild it explicitly:

```bash
ynm reindex
ynm status
```

Expected: `personal: 0 memories indexed` and `project: 1 memories indexed`, then a status where
both are `fresh` again. You rarely need this by hand. Recall rebuilds a stale index on its own,
so a missing or out-of-date index costs one slow query and no data. `reindex` is for when you want
to pay that cost now, or after copying a store between machines.

## Try the SQLite provider

By default a store is git notes: durable, mergeable, shareable through any git remote. The
alternative keeps the log in one SQLite file, which drops the git write path entirely. Choose it
per repository in its config, before initialising:

```bash
cd /tmp/ynm-tutorial
git init -q -b main sqlite-project
git -C /tmp/ynm-tutorial/sqlite-project -c user.name=tutorial -c user.email=tutorial@example.com commit -q --allow-empty -m "first commit"
mkdir -p sqlite-project/.ynm
echo '{"provider":"sqlite"}' > sqlite-project/.ynm/config.json
cd sqlite-project
ynm init
cat .ynm/config.json
```

Expected: an `initialised` report, and a config that kept your choice and gained the anchor:

```text
{
  "provider": "sqlite",
  "anchor": "<40-hex sha>"
}
```

```bash
ynm remember --type semantic --level distributed --content "This project keeps memory in SQLite."
ynm status
find .ynm -type f | sort
git for-each-ref refs/notes
```

Expected: `remembered <id> in project`. In `status` both mounts now say `sqlite` where they said
`git-notes`, and the project one has `1 shard(s)`. The files are the config, the derived index and the
store itself:

```text
.ynm/config.json
.ynm/index/project.sqlite
.ynm/store-sqlite/store.sqlite
```

`git for-each-ref` prints nothing: no notes were written. Memory in this provider does not travel
with the repository, so `ynm sync` has nothing to send. Use it for a hosted store or a store
that is only yours.

```bash
ynm doctor
```

Expected: all `ok`. The mount lines report `(sqlite)` with the path of `store.sqlite`, its
`records` and `shards`, and the sync line says `remote "origin" not configured; sync
unavailable`.

## Back up and restore

A git-notes store is a git repository, so a backup is a bundle: one file holding every ref,
including the memory. Back up the first project and restore it into a clone made only from the
bundle:

```bash
cd /tmp/ynm-tutorial/project
git bundle create /tmp/ynm-tutorial/backup.bundle --all
git bundle list-heads /tmp/ynm-tutorial/backup.bundle
```

Expected: `list-heads` prints three lines, each a 40-hex sha and a ref: `refs/heads/main`, the memory shard `refs/notes/ynm/shared/common/semantic/<yyyy-mm>`,
and `HEAD`.

Clone the bundle, then fetch the notes, which a plain clone leaves behind:

```bash
git clone -q /tmp/ynm-tutorial/backup.bundle /tmp/ynm-tutorial/restored
git -C /tmp/ynm-tutorial/restored fetch -q /tmp/ynm-tutorial/backup.bundle 'refs/notes/ynm/*:refs/notes/ynm/*'
git -C /tmp/ynm-tutorial/restored for-each-ref --format='%(refname)' refs/notes
```

Expected: the shard is there:

```text
refs/notes/ynm/shared/common/semantic/<yyyy-mm>
```

`ynm init` in the restored clone sets it up again, and the memory is back. It uses a fresh home
so nothing from the original leaks in:

```bash
cd /tmp/ynm-tutorial/restored
YNM_HOME=/tmp/ynm-tutorial/home2 ynm init --personal
YNM_HOME=/tmp/ynm-tutorial/home2 ynm init
YNM_HOME=/tmp/ynm-tutorial/home2 ynm list --level distributed
```

Expected: the personal store is created under `home2`, `init` reports the same anchor as the
original project (it is the root commit both share), and the list shows the one memory:

```text
<id>  semantic   distributed common                   Backups are taken with git bundle.
```

Your personal store is a bare repository too, at `$YNM_HOME/store.git`. Bundle it the same way
(`git -C "$YNM_HOME/store.git" bundle create personal.bundle --all`), and keep it somewhere the
project's backups are not: personal memory is private, and the two should never share a
destination that other people can read. For a SQLite store, copy the file once nothing is
writing to it. The index is derived, so leave it out.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER YNM_NO_CLAUDE_CLI
```

Next: tutorial 12, evals and benchmarks, where you measure ynm itself.
