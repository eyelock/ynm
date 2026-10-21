# Project Memory

Turn a git repository into a distributed memory store, write memory the whole team will see, keep
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
git config user.name tutorial
git config user.email tutorial@example.com
git commit -q --allow-empty -m "first commit"
```

The two `git config` lines give this repository its own commit identity, so the commits in this
tutorial work even on a machine with no git identity set.

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git` and nothing else.

## Initialise the repository

```bash
ynm init
```

Expected: an `initialised` line with the project path, then indented lines. The anchor is the
repository's root commit (`root-commit`), the config file is `.ynm/config.json`, and a
`pre-push` hook was installed. One note says the local wiki and index directories were excluded
in `.git/info/exclude`. Another says there is no remote `origin` yet, so distributed memory stays
in this clone until you add one; you do that in tutorial 6, and nothing needs re-running then.
Only if this repository already uses an agent client is there a `client` line for it. Here none
does; if agent clients are installed on your machine, one `also` line names them. The `commit`
line lists the files the team shares, here only `.ynm/config.json`, and the `memory` line says
where the memories themselves live. Ends with a `next:` hint.

```text
initialised <project path>
  anchor    <40-hex sha> (root-commit)
  config    <project path>/.ynm/config.json
  hooks     <project path>/.git/hooks/pre-push
  note      added .ynm/wiki/ and .ynm/index/ to .git/info/exclude
  note      no remote "origin" yet; distributed memory stays in this clone until you add one, then `ynm sync` shares it
  also      <client names> on this machine but not used here; add one with `ynm client install <name>`
  commit    .ynm/config.json
            the team shares these; commit them so every clone gets the same setup
  memory    lives in git notes, not in files; `ynm sync` and the pre-push hook share it
next: `ynm remember --type semantic --content "..."` and `ynm doctor`
```

`ynm init` configures only the agent clients this repository already uses, meaning it has a
project file for them such as `.mcp.json` or `.claude/` for Claude Code: the MCP server, the memory
guidance, and the hooks that put memory in front of the agent. A client found only on your machine
(its executable on PATH, or settings in your home directory) gets no files, which is what the `also`
line says; you add it deliberately with `ynm client install <name>`. Init writes only inside the
repository; a step that would touch your home directory is printed as a `run:` line instead.
Tutorial 7 covers the clients; `ynm init --no-clients` skips the step.

For memory itself, `ynm init` changes no branch, commit or tracked file. It wrote
`.ynm/config.json`, which records the anchor, the commit memory attaches to. The
derived `.ynm/wiki/` and `.ynm/index/` directories are kept out of the repository by
`.git/info/exclude`, git's per-clone ignore file (each folder also holds a `.gitignore` of `*`,
written when ynm creates it, so other clones ignore it too):

```bash
cat .ynm/config.json
git status --short
```

Expected: a JSON object with a single `anchor` key holding the same sha, then `?? .ynm/` and
nothing else, because init wrote no client files here.

## What to commit

`.ynm/` shows as untracked because `.ynm/config.json` is new, and it belongs in git: it tells
every clone that this repository has memory and which commit that memory attaches to, and it is
where the team's mounts and redaction settings go later. The derived `.ynm/wiki/` and
`.ynm/index/` directories are already excluded, so adding the directory adds only the config:

```bash
git add .ynm
git commit -q -m "Add ynm memory"
git status --short
```

Expected: no output. The work tree is clean.

The rule is the one init prints. Commit what the `commit` line lists: `.ynm/config.json`, plus
any client files for clients the team uses, such as `.mcp.json` and the guidance block in
`AGENTS.md` or `CLAUDE.md`. Leave what the `local` line lists: those files are one person's own
(Claude Code's hooks in `.claude/settings.local.json`), and init excludes them from git for you.
The memories are not files at all: they are git notes, which `ynm sync` and the pre-push hook
move, so there is nothing else to add.

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

## Write distributed memory

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

Distributed memory is git notes in this repository, under `refs/notes/ynm/distributed/`:

```bash
git for-each-ref --format='%(refname)' refs/notes
```

Expected: one ref per namespace, type and month.

```text
refs/notes/ynm/distributed/common/procedural/<yyyy-mm>
refs/notes/ynm/distributed/org/eyelock/project/demo/semantic/<yyyy-mm>
```

No personal ref appears here, and `ynm doctor` checks that it never does:

```bash
ynm doctor
```

Expected: every line `ok`, including `no personal refs in project repo: ok`, the
pre-push hook, and `remote "origin" not configured; sync unavailable`. Tutorial 6 adds the
remote. The `client` lines at the end, one per agent client on your machine (there may be none),
say `ynm not registered` and name the `ynm client install` command, because init configured none
of them in this project.

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
