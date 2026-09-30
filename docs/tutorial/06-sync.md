# Sync

Two people, two clones, one remote. Share a project's memory through the same remote as the
code, watch concurrent writes merge, and see the hook that keeps them in step. Along the way,
confirm that personal memory never leaves your machine.

## Prerequisites

`ynm` is on your PATH. Prepare the sandbox and a personal store:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
cd /tmp/ynm-tutorial
ynm init --personal
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git` and nothing else.

## A remote and two clones

The remote is an ordinary bare repository; a forge would do the same job. Alice creates the
project and pushes its first commit; Bob clones it:

```bash
git init -q --bare -b main /tmp/ynm-tutorial/remote.git
git init -q -b main /tmp/ynm-tutorial/alice
git -C /tmp/ynm-tutorial/alice remote add origin /tmp/ynm-tutorial/remote.git
git -C /tmp/ynm-tutorial/alice -c user.name=alice -c user.email=alice@example.com commit -q --allow-empty -m "first commit"
git -C /tmp/ynm-tutorial/alice push -q -u origin main
git clone -q /tmp/ynm-tutorial/remote.git /tmp/ynm-tutorial/bob
git -C /tmp/ynm-tutorial/bob log --oneline
```

Expected: one commit, `<short sha> first commit`. Both clones share it, and it is the anchor
their memory attaches to.

## Initialise both clones

```bash
cd /tmp/ynm-tutorial/alice
ynm init
```

Expected: an `initialised <project path>` line, then the anchor, the config path, the
`refspecs` ynm configured on `origin`, the hook, and a note that the local wiki and index
directories were excluded in `.git/info/exclude`. There is no "remote not found" note this time, because
`origin` exists. Alice's clone uses no agent client, so there is no `client` line; an `also` line
naming clients found on your machine (tutorial 2) may appear, and varies.

```text
initialised <project path>
  anchor    <40-hex sha> (root-commit)
  config    <project path>/.ynm/config.json
  refspecs  +refs/notes/ynm/shared/*:refs/notes/ynm-remote/origin/shared/*
  hooks     <project path>/.git/hooks/pre-push
  note      added .ynm/wiki/ and .ynm/index/ to .git/info/exclude
  also      <client names> on this machine but not used here; add one with `ynm client install <name>`
next: `ynm remember --type semantic --content "..."` and `ynm doctor`
```

That one refspec is a fetch. `ynm init` adds no push refspec: the pre-push hook, below, is the
only thing that pushes notes, so git's own push never races it. Git's own configuration is the
source of truth:

```bash
git -C /tmp/ynm-tutorial/alice config --get-all remote.origin.fetch
git -C /tmp/ynm-tutorial/alice config --get-all remote.origin.push || echo "no push refspec"
```

Expected: the fetch lines are the ordinary branch refspec and a second one that brings the
remote's shared memory into a separate namespace, so it can be merged rather than overwritten:

```text
+refs/heads/*:refs/remotes/origin/*
+refs/notes/ynm/shared/*:refs/notes/ynm-remote/origin/shared/*
```

The second command prints only `no push refspec`: there are no push lines. Only `shared` is ever mapped; the
personal level has no refspec at all.

Now Bob:

```bash
cd /tmp/ynm-tutorial/bob
ynm init
```

Expected: the same shape as Alice's, with Bob's project path and the same anchor sha: it is the
root commit both clones share.

## Write in both, before either syncs

Each person writes a distributed memory. Neither knows about the other's yet:

```bash
cd /tmp/ynm-tutorial/alice
ynm remember --type semantic --level distributed --content "Alice: the API listens on port 8080."
cd /tmp/ynm-tutorial/bob
ynm remember --type semantic --level distributed --content "Bob: the worker reads its queue from Redis."
```

Expected: `remembered <26-character id> in project` from each.

## Sync

`ynm sync` fetches the remote's shared memory, merges it into yours, and pushes. Alice goes
first:

```bash
cd /tmp/ynm-tutorial/alice
ynm sync
```

Expected: nothing to fetch yet, one thing pushed.

```text
project: fetched 0, merged 0, pushed 1, retries 0
```

Bob's sync has something to fetch, and merges it with what he wrote:

```bash
cd /tmp/ynm-tutorial/bob
ynm sync
ynm list --level distributed
```

Expected: `project: fetched 1, merged 1, pushed 1, retries 0`, then both memories, Bob's and
Alice's:

```text
<id>  semantic   distributed common                   Bob: the worker reads its queue from Redis.
<id>  semantic   distributed common                   Alice: the API listens on port 8080.
```

Alice syncs again to collect Bob's:

```bash
cd /tmp/ynm-tutorial/alice
ynm sync
ynm list --level distributed
```

Expected: a `project: fetched ...` line ending `retries 0`, and the same two memories, in
the same order. The merge never loses a record because memory is an append-only log:
both sides only ever added lines.

## Personal memory stays home

Remember something personal in Alice's clone, then sync:

```bash
cd /tmp/ynm-tutorial/alice
ynm remember --type semantic --content "Alice: my notes live in the wiki."
ynm sync
git -C /tmp/ynm-tutorial/remote.git for-each-ref --format='%(refname)'
```

Expected: `remembered <id> in personal`, a sync line, and the remote's refs, only the code branch
and the shared memory:

```text
refs/heads/main
refs/notes/ynm/shared/common/semantic/<yyyy-mm>
```

No `personal` ref exists on the remote. Sync never touches the personal store unless you
name it with `--mount personal`.

## The pre-push hook

`ynm init` installed a hook, so a plain `git push` syncs memory too. Make a commit and push it
with git tracing on, keeping only the lines that mention the hook:

```bash
git -C /tmp/ynm-tutorial/alice -c user.name=alice -c user.email=alice@example.com commit -q --allow-empty -m "second commit"
GIT_TRACE=1 git -C /tmp/ynm-tutorial/alice push 2>&1 | grep "hooks/pre-push"
```

Expected: two trace lines that run `.git/hooks/pre-push origin <remote path>`. The hook ran
`ynm sync --quiet`, which prints nothing when it works.

Two things to know about it. It never blocks a push: it ends with `exit 0` even if sync fails,
and you can repair with a manual `ynm sync`. And the push above found nothing new to send; when
a push does carry new shared memory, the hook publishes it first, then git pushes the branch and
exits 0.

## Doctor sees the remote

```bash
cd /tmp/ynm-tutorial/alice
ynm doctor
```

Expected: every line starts with `ok`. Among them are `shared fetch refspec`, `personal refs never pushed: no personal refspecs in remote config (ADR-007)`,
`no personal refs in project repo: ok (ADR-007)` and `pre-push hook`. The two mount lines
report `"remote":"origin"`. Any `client` lines at the end are agent clients found on your
machine, each saying `ynm not registered`: `ynm init` configured none in Alice's clone.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER
```

Next: tutorial 7, connecting an agent, where an MCP client gets the same memory.
