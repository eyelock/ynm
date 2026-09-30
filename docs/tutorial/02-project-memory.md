# Project Memory

Turn a git repository into a shared memory store, write memory the whole team will see, keep
it in namespaces, and watch the redaction gate refuse a secret.

## Prerequisites

`ynm` is on your PATH. Prepare the sandbox and a personal store as in tutorial 1, then create a
repository with one commit:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
cd /tmp/ynm-tutorial
ynm init --personal
git init -q -b main project
cd project
git -c user.name=tutorial -c user.email=tutorial@example.com commit -q --allow-empty -m "first commit"
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git` and nothing else.

## Initialise the repository

```bash
ynm init
```

Expected: an `initialised` line with the project path, then five indented lines. The anchor is
the repository's root commit (`root-commit`), the config file is `.ynm/config.json`, a
`pre-push` hook was installed, one note says the local wiki and index directories were excluded
in `.git/info/exclude`, and another says remote `origin` was not found so refspecs were not configured.
Then one `client` line for each agent client detected on your machine, possibly with a `run:`
line after it, and none if none is detected. Ends with a `next:` hint.

```text
initialised <project path>
  anchor    <40-hex sha> (root-commit)
  config    <project path>/.ynm/config.json
  hooks     <project path>/.git/hooks/pre-push
  note      added .ynm/wiki/ and .ynm/index/ to .git/info/exclude
  note      remote "origin" not found; refspecs not configured (re-run init after adding it)
  client    claude-code: .mcp.json, CLAUDE.md, 3 hooks
next: `ynm remember --type semantic --content "..."` and `ynm doctor`
```

The `client` line above is what a machine with Claude Code sees. `ynm init` configures every
agent client it detects (its executable on PATH, its settings in your home directory, or its
files in the project): the MCP server, the memory guidance, and the hooks that put memory in
front of the agent. It writes only inside the repository; a step that would touch your home
directory is printed as a `run:` line instead. Tutorial 7 covers the clients;
`ynm init --no-clients` skips them.

For memory itself, `ynm init` changes no branch, commit or tracked file. It wrote
`.ynm/config.json`, which records the anchor (commit it so teammates share the same anchor). The
derived `.ynm/wiki/` and `.ynm/index/` directories are kept out of the repository by
`.git/info/exclude`, git's per-clone ignore file:

```bash
cat .ynm/config.json
git status --short
```

Expected: a JSON object with a single `anchor` key holding the same sha, then `?? .ynm/`, and
one `??` line for each client file init wrote, if any (for Claude Code: `?? .claude/`,
`?? .mcp.json` and `?? CLAUDE.md`).

## Two mounts

```bash
ynm status
```

Expected: the config path, then two mounts, both empty: `personal` at the personal level and
`project` at the distributed level, the second pointing at the project path.

```text
ynm 0.1.0
config: <project path>/.ynm/config.json
  personal   personal     git-notes  0 shard(s)  index fresh (0)  /tmp/ynm-tutorial/home/store.git
  project    distributed  git-notes  0 shard(s)  index fresh (0)  <project path>
```

## Write shared memory

Memory is personal unless you say otherwise. `--level distributed` routes it to the project
mount, in the `common` namespace by default:

```bash
ynm remember --type procedural --level distributed --content "Run pnpm check before pushing; CI rejects unformatted code." --tags ci
```

Expected:

```text
remembered <26-character id> in project
```

Note `in project`, not `in personal`.

## Namespaces

A namespace groups memories below the level. Use one when a store serves more than one
project or team:

```bash
ynm remember --type semantic --level distributed --namespace org/eyelock/project/demo --content "The demo project deploys from the release branch."
ynm list --level distributed
```

Expected: `remembered <id> in project`, then the list shows both distributed memories with
their namespaces, newest first:

```text
<id>  semantic   distributed org/eyelock/project/demo The demo project deploys from the release branch.
<id>  procedural distributed common                   Run pnpm check before pushing; CI rejects unformatted code.
```

Recall filters by namespace prefix, so `org/eyelock` matches everything under it:

```bash
ynm recall --text "deploys" --namespace org/eyelock
```

Expected: one hit, from the `project` mount.

```text
0.875  <id>  semantic   project   The demo project deploys from the release branch.
```

## The redaction gate

Every distributed write passes through redaction patterns (private keys, cloud and GitHub
tokens, bearer headers). A match is refused before anything is written:

```bash
ynm remember --type semantic --level distributed --content "Deploy token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" || echo "exit $?"
```

Expected: an error naming the pattern that matched, and exit code 2.

```text
 ›   Error: refused: content matches 1 redaction pattern:
 ›   gh[pousr]_[A-Za-z0-9]{20,}
exit 2
```

The same content is accepted into personal memory, because personal memory never leaves your
machine. Try it if you like, then forget it: secrets do not belong in memory at any level.

## Where it went

Shared memory is git notes in this repository, under `refs/notes/ynm/shared/`:

```bash
git for-each-ref --format='%(refname)' refs/notes
```

Expected: one ref per namespace, type and month.

```text
refs/notes/ynm/shared/common/procedural/<yyyy-mm>
refs/notes/ynm/shared/org/eyelock/project/demo/semantic/<yyyy-mm>
```

No personal ref appears here, and `ynm doctor` checks that it never does:

```bash
ynm doctor
```

Expected: every line `ok`, including `no personal refs in project repo: ok (ADR-007)`, the
pre-push hook, and `remote "origin" not configured; sync unavailable`. Tutorial 6 adds the
remote. The `client` lines at the end, one per agent client `ynm init` found, say
`server, guidance and hooks in place` for each client it configured.

## The hook

```bash
cat .git/hooks/pre-push
```

Expected: a four-line shell script that runs `ynm sync --quiet` when `ynm` is on PATH and exits
early when `YNM_SYNC_IN_PROGRESS` is set (sync itself pushes, so the guard stops it re-entering).

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER
```

Next: tutorial 3, recall and context, where filters, explanations and pinning shape what an
agent sees.
