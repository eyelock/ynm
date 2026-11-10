# Retrofit an existing repository

Goal: give a repository that already has history, branches and a team a distributed ynm memory,
without disturbing any of it.

## Run init

From inside the repository:

```bash
ynm init
```

For memory, `ynm init` changes no branch, tag, commit or tracked file. It does five things:

- writes `.ynm/config.json`, which records the anchor (the repository's root commit); it stays
  in your clone, because ynm works the anchor out again in any clone;
- adds a fetch refspec for `refs/notes/ynm/distributed/*` to `remote.origin` in
  `.git/config` (pass `--remote <name>` to use another remote; if the remote does not exist yet,
  the first `ynm sync` after you add it sets this up, so there is nothing to re-run);
- installs a `pre-push` hook that runs `ynm sync --quiet`, unless you pass `--no-hooks` or set
  `"hooks": false` in your config;
- adds `.ynm/` to `.git/info/exclude` (git's per-clone ignore file, never committed) when it is
  not already excluded, and says so in a note;
- builds the search index under `.ynm/index/`, and puts a `.gitignore` containing `*` inside that
  folder (and inside `.ynm/wiki/` when the wiki is built) so it ignores itself in every clone.

Memory itself appears only when someone writes it, as refs under `refs/notes/ynm/`. Teammates who
have not run `ynm init` see nothing and are not affected.

Then it configures the agent clients the repository already uses, and it never edits a file git
tracks or leaves an untracked file in view. A client counts as used when the repository has its project footprint (`.mcp.json` or
`.claude/` for Claude Code, `opencode.json` or `opencode.jsonc` for OpenCode, `.pi/` for Pi).
For Claude Code init registers the server with `claude mcp add --scope local` (recorded in your
own Claude Code config, so no `.mcp.json`), writes no instruction block (the session-start hook
and the server's instructions carry the guidance) and puts the hooks in the untracked
`.claude/settings.local.json`; for OpenCode `opencode.json`; `AGENTS.md` for the clients that
read it; the Pi extension under `.pi/`. A file init has to create is excluded in
`.git/info/exclude`. A client found only on your machine gets no files, just
one `also` line suggesting `ynm client install <name>`; a repository that has never used an agent
client therefore gets no client files at all. Init never installs into a ynh harness. When the
repository already tracks one of these files, init leaves it alone and prints a `left` line
naming it; add ynm's entry there by hand if the team wants it, or use the manual `ynm client
install`, which merges into it (other servers, hooks and settings are kept, the file's
indentation and trailing newline are preserved, and in the instruction files only the text
between the `<!-- ynm:guidance -->` markers is rewritten). Each client the project uses gets
one `client` line in the report. See
[Install ynm](install.md#set-up-your-agent-clients) for what each gets. To keep init to memory
alone, run `ynm init --no-clients`.

If you work through a ynh harness, the repository needs nothing for the agent to have ynm: ynh
assembles ynm's server, hooks and skill at every launch, and memory goes to your personal store.
Run `ynm init --no-clients` here only to add distributed, team memory, so that init does not also
register a server and write hooks that duplicate the harness.

## What to commit

Nothing: `ynm init` leaves `git status` as it found it, and ends with a `local` line naming the
files that are one person's own, which it has already excluded from git. The Claude Code hooks
are the example: init puts them in `.claude/settings.local.json`, Claude Code's personal project
settings, and leaves the team's `.claude/settings.json` untouched, because a hook that runs
`ynm` fails for a teammate who has not installed it. Teammates who want the hooks run
`ynm init` in their own clone. To share `.ynm/config.json` (mounts, redaction settings) or a
client file such as `.mcp.json` with the team, add it on purpose: `git add -f .ynm/config.json`,
or `ynm client install <name>` for the client files, which writes the team-shareable form. Keep
a client file out of git if it carries a token (see [Connect a client over HTTP](connect-over-http.md)).
The derived directories are excluded through `.git/info/exclude`, which git keeps per clone and
never commits, and each folder holds a `.gitignore` of `*` that ynm writes when it creates the
folder, so a clone where `ynm init` never ran stays clean too. If you would
rather have the rule in the repository's own `.gitignore` so it applies to every clone, add:

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
`refs/notes/ynm/`; delete those refs only if you mean to discard it. For the clients, remove the
`ynm` entry from each client's server config, the `ynm hook` entries from
`.claude/settings.local.json`, and the text between the `<!-- ynm:guidance -->` markers.
