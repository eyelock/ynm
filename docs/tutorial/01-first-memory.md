# Your First Memory

Create a personal memory store, remember two facts, recall them, and see exactly what ynm wrote
to git.

## Prerequisites

`ynm` is installed and on your PATH (see [Install](README.md#install)). Prepare the sandbox:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
cd /tmp/ynm-tutorial
ynm --version
```

Expected:

```text
@ynm/cli/0.1.0 <platform> node-v<version>
```

## Create the personal store

Personal memory lives in a bare git repository under your ynm home. It is created once and
never enters any project repository.

```bash
ynm init --personal
```

Expected:

```text
personal store created at /tmp/ynm-tutorial/home/store.git
```

## Check status

```bash
ynm status
```

Expected:

```text
ynm 0.1.0
config: defaults
  personal   personal     git-notes  0 shard(s)  index fresh (0)  /tmp/ynm-tutorial/home/store.git
```

One mount: `personal`, at the `personal` level, using the git-notes provider, empty. There is
no project mount because `/tmp/ynm-tutorial` is not a git repository; tutorial 2 adds one.

## Remember two facts

Every memory has a type. A decision or a stable fact is `semantic`; something you do is
`procedural`. The [six types](../explanation/memory-types.md) are explained separately; for now,
pick the one that matches the sentence.

```bash
ynm remember --type semantic --content "The team deploys on Tuesdays; never on a Friday." --tags deploy
ynm remember --type procedural --content "To run the test suite: pnpm test. Run pnpm check first, it is faster." --tags testing
```

Expected, one line per command, each with a different 26-character id:

```text
remembered 01M3P8JQT7MGJS23ZSY442P3Z6 in personal
remembered 01M3P8JR5AR59QXSBTDS96MEZX in personal
```

Memories are personal by default. Nothing you remember reaches a distributed store unless you say
`--level distributed`.

## Recall

Recall is a search, not a list. Ask a question in your own words:

```bash
ynm recall --text "when do we deploy"
```

Expected: one hit, a score, the id, the type, the level and the content.

```text
0.875  01M3P8JQT7MGJS23ZSY442P3Z6  semantic   personal  The team deploys on Tuesdays; never on a Friday.
```

A query that matches nothing says so and exits successfully:

```bash
ynm recall --text "kubernetes"
```

Expected:

```text
no matches
```

## The same thing as JSON

Every command takes `--json`; this is the shape the MCP tool returns to an agent.

```bash
ynm recall --text "test suite" --json
```

Expected: a JSON array with one object. The fields include `memoryId`, `mount`, `score`,
`type: "procedural"`, `level: "personal"`, `namespace: "user/tutorial"`, `tags: ["testing"]`,
`summary`, `content`, `pinned: false`, `importance: 0.5` and an `updatedAt` timestamp.

## List everything

```bash
ynm list
```

Expected: both memories, newest first, with id, type, level, namespace and content:

```text
01M3P8JR5AR59QXSBTDS96MEZX  procedural personal    user/tutorial            To run the test suite: pnpm test. Run pnpm check first, it is faster.
01M3P8JQT7MGJS23ZSY442P3Z6  semantic   personal    user/tutorial            The team deploys on Tuesdays; never on a Friday.
```

The namespace `user/tutorial` came from `YNM_USER`. Without it, ynm uses your OS username.

## The context block

`ynm context` renders what an agent reads at the start of a session: pinned memories first,
then the most relevant and recent ones, packed to a token budget.

```bash
ynm context
```

Expected:

```text
## Memory
- (procedural) To run the test suite: pnpm test. Run pnpm check first, it is faster. [testing]
- (semantic) The team deploys on Tuesdays; never on a Friday. [deploy]
```

## Look under the hood

Status now shows two shards, one per memory type and month:

```bash
ynm status
```

Expected:

```text
ynm 0.1.0
config: defaults
  personal   personal     git-notes  2 shard(s)  index fresh (2)  /tmp/ynm-tutorial/home/store.git
```

Each shard is a git ref under `refs/notes/ynm/`. Nothing is hidden:

```bash
git -C /tmp/ynm-tutorial/home/store.git for-each-ref --format='%(refname)'
```

Expected:

```text
refs/heads/main
refs/notes/ynm/personal/user/tutorial/procedural/2026-09
refs/notes/ynm/personal/user/tutorial/semantic/2026-09
```

The month in the ref name is the month you ran this. The ref path reads level, namespace, type,
month. A shard is a JSONL file, one record per line, attached as a git note to the store's root
commit:

```bash
ANCHOR=$(git -C /tmp/ynm-tutorial/home/store.git rev-list --max-parents=0 main)
git -C /tmp/ynm-tutorial/home/store.git notes --ref "refs/notes/ynm/personal/user/tutorial/semantic/$(date +%Y-%m)" show "$ANCHOR"
```

Expected: one line of JSON containing `"op":"create"`, `"type":"semantic"`,
`"level":"personal"`, `"namespace":"user/tutorial"`, the content, `"tags":["deploy"]`, a
`recordedAt` timestamp and a `provenance` object with `"actor":"user:tutorial"`.

That line is the whole story: memory is an append-only log in git. Everything else, the index,
the ranking, the wiki, is derived from it and can be rebuilt.

## Doctor

```bash
ynm doctor
```

Expected: every line starts with `ok`; the mount line reports two shards and `"badLines":0`,
and a line says you are not inside a git repository, so only the personal store is mounted.
After it come `client` lines for agent clients found on your machine, if any, saying whether ynm
is set up there (`ynm not registered` until you install it); tutorial 7 covers them.

## Cleanup

```bash
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER
```

Next: tutorial 2, project memory, where `ynm init` inside a repository adds the distributed mount.
