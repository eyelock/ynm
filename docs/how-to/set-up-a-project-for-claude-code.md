# Set up a project for Claude Code without touching your own config

Goal: give a repository ynm memory and Claude Code's ynm wiring so that every clone gets both,
without touching your own Claude Code configuration: no `claude mcp add`, and nothing written to
`~/.claude` or `~/.claude.json`, at any step.

What each step writes:

| Step | Inside the project | Outside the project |
|---|---|---|
| `ynm init --no-clients` | `.ynm/config.json`, `.git/config`, the `pre-push` hook, `.git/info/exclude` | nothing |
| `ynm client install claude-code` | `.mcp.json`, `CLAUDE.md`, `.claude/settings.local.json` | nothing |
| first use of memory: `ynm remember`, `ynm sync`, `ynm recall` | memory at level `distributed`, as notes in `.git` | your personal store, created in `~/.ynm` (`store.git`, `index/`), or in `$YNM_HOME` when that is set |

`~/.ynm` is ynm's home on your machine, not Claude Code's configuration: every repository you use
ynm in shares it, and [Back up and restore](back-up-and-restore.md#your-personal-store) covers it.

## Why not plain `ynm init`

`ynm init` configures the clients a repository already uses. For Claude Code it runs
`claude mcp add --scope local`, which records the server in **your own** Claude Code
configuration, outside the project. It also keeps what it writes out of git, so a teammate's clone
gets none of it. Use the route below when you want the setup to travel with the repository, or
when the machine's own Claude Code configuration must stay as it is.

| Route | Writes your own Claude Code config | Writes files the clone shares |
|---|---|---|
| `ynm init` (clients the project uses) | yes, through `claude mcp add --scope local` | no: init excludes what it creates |
| `ynm init --client claude-code` | yes, the same | no |
| `ynm init --no-clients`, then `ynm client install claude-code` (this guide) | no | yes: `.mcp.json` and `CLAUDE.md`, which you commit |
| `ynm client install claude-code --scope user` | yes, through `claude mcp add --scope user` and `~/.claude/settings.json` | no |

## In the first clone

Run both commands once from the repository's root:

```bash
ynm init --no-clients
ynm client install claude-code
```

`ynm init --no-clients` creates the distributed memory mount: `.ynm/config.json`, the fetch
refspec for `refs/notes/ynm/distributed/*` in `.git/config`, the `pre-push` hook, and
`.ynm/` in `.git/info/exclude`. It touches no client.

`ynm client install claude-code` defaults to `--scope project` and writes three things, all inside
the project:

- `.mcp.json`: the `ynm` server, `ynm serve` over stdio;
- `CLAUDE.md`: a block between `<!-- ynm:guidance -->` markers (or a new `CLAUDE.md` importing
  `AGENTS.md`, when that is the only instruction file); other text in the file is kept;
- `.claude/settings.local.json`: the `SessionStart`, `UserPromptSubmit` and `Stop` hooks, each
  running `ynm hook`. This is Claude Code's personal project file, not the team's
  `.claude/settings.json`, because a hook that runs `ynm` fails for a teammate who has not
  installed it. `--no-hooks` skips it.

Run `ynm client plan claude-code` first to see exactly what would change; it writes nothing.

`.claude/settings.local.json` is not ignored by git yet: `git status` lists it as untracked beside
the other two, so a `git add -A` or `git add .` would commit it. Ignore it in the repository's
`.gitignore`, which you commit with the other two files so every clone ignores it too:

```bash
echo ".claude/settings.local.json" >> .gitignore
git status --short
```

Expected: `.gitignore`, `.mcp.json` and `CLAUDE.md` (as `??`, or `M` when the file was already
tracked), and no `.claude/settings.local.json`.

Commit what the team shares, then push the branch and the memory:

```bash
git add .gitignore .mcp.json CLAUDE.md
git commit -m "ynm project setup for Claude Code"
git push
ynm sync
```

## In every other clone

```bash
git clone <url> project && cd project
ynm init --no-clients
ynm sync
```

The clone already has `.mcp.json`, `CLAUDE.md` and the `.gitignore` line, so Claude Code finds the
server and the guidance, and `ynm init --no-clients` points the clone at the distributed memory,
which `ynm sync` fetches. On a machine where ynm has not been used before, that `ynm sync` also
creates `~/.ynm`. `ynm recall` then returns what the first clone remembered at level
`distributed`. To get the session hooks in this clone too, run `ynm client install claude-code`:
with the other two files in place it writes only `.claude/settings.local.json`, which the
committed `.gitignore` line keeps out of `git status`.

## Check it left your Claude Code configuration alone

`ynm client status` prints the checks. The two setup commands are run against an isolated home,
with a stand-in `claude` that records every call, by the test in
`packages/cli/src/commands/project-setup.test.ts`: it fails if `claude mcp` is run, if anything
under the home directory or ynm's own home appears during setup, or if the project gains a file
other than the three above; and it fails unless a fresh clone reads the first clone's distributed
memory. The test gives each clone its own `YNM_HOME`, so it does not show `~/.ynm` being created;
that happens on first use, as the table at the top says.

## Undo

Delete `.mcp.json`, the block between the `ynm:guidance` markers in `CLAUDE.md`, the `ynm hook`
entries in `.claude/settings.local.json`, the `.claude/settings.local.json` line in `.gitignore` if
nothing else needs it, and follow [Retrofit an existing repository](retrofit-an-existing-repo.md#undo)
for the memory mount. There is nothing to remove from your own Claude Code configuration.
`~/.ynm` holds your personal memory from every repository, so leave it unless you mean to remove
all of it.
