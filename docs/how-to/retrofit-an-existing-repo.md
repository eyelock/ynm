# Retrofit an existing repository

Goal: give a repository that already has history, branches and a team a shared ynm memory,
without disturbing any of it. Background: [ADR-009](../adr/009-hosting-and-bootstrap.md).

## Run init

From inside the repository:

```bash
ynm init
```

For memory, `ynm init` changes no branch, tag, commit or tracked file. It does five things:

- writes `.ynm/config.json`, which records the anchor (the repository's root commit) and is the
  one file worth committing, so teammates share the anchor and any mounts or redaction settings;
- adds a fetch refspec for `refs/notes/ynm/shared/*` to `remote.origin` in
  `.git/config` (pass `--remote <name>` to use another remote; without the remote it prints a
  note and you re-run `init` after adding it);
- installs a `pre-push` hook that runs `ynm sync --quiet`, unless you pass `--no-hooks` or set
  `"hooks": false` in your config;
- adds `.ynm/wiki/` and `.ynm/index/` to `.git/info/exclude` (git's per-clone ignore file, never
  committed) when they are not already ignored, and says so in a note;
- builds the search index under `.ynm/index/`.

Memory itself appears only when someone writes it, as refs under `refs/notes/ynm/`. Teammates who
have not run `ynm init` see nothing and are not affected.

Then it configures the agent clients the repository already uses, and this part does write work
tree files. A client counts as used when the repository has its project footprint (`.mcp.json` or
`.claude/` for Claude Code, `opencode.json` or `opencode.jsonc` for OpenCode, `.pi/` for Pi).
For Claude Code init writes `.mcp.json`, a delimited block in `CLAUDE.md` and hooks in
`.claude/settings.local.json`; for OpenCode `opencode.json`; `AGENTS.md` for the clients that
read it; the Pi extension under `.pi/`. A client found only on your machine gets no files, just
one `also` line suggesting `ynm client install <name>`; a repository that has never used an agent
client therefore gets no client files at all. Init never installs into a ynh harness. When the
repository already tracks one of these files, ynm merges into it: other servers, hooks and
settings are kept, the file's indentation and trailing newline are preserved, and in `CLAUDE.md`
and `AGENTS.md` it only ever rewrites the text between its `<!-- ynm:guidance -->` markers. Each
client the project uses gets one `client` line in the report. See
[Install ynm](install.md#set-up-your-agent-clients) for what each gets. To keep init to memory
alone, run `ynm init --no-clients`.

If you work through a ynh harness, the repository needs nothing for the agent to have ynm: ynh
assembles ynm's server, hooks and skill at every launch, and memory goes to your personal store.
Run `ynm init --no-clients` here only to add shared, team memory, so that init does not also
write `.mcp.json`, `CLAUDE.md` and hooks that duplicate the harness.

## What to commit

Commit `.ynm/config.json`. The client files are your team's choice: committing `.mcp.json` and
the guidance blocks gives every teammate the same setup when they open the repository, and
`ynm init` in their clone reports them `unchanged`. The Claude Code hooks are the exception:
init puts them in `.claude/settings.local.json`, Claude Code's personal project settings, and
leaves the team's `.claude/settings.json` untouched, because a hook that runs `ynm` fails for a
teammate who has not installed it. Teammates who want the hooks run `ynm init` (or
`ynm client install claude-code`) in their own clone. Keep a client file out of git if it
carries a token (see [Connect a client over HTTP](connect-over-http.md)).
Nothing else changed in the work tree: the derived directories are
excluded through `.git/info/exclude`, which git keeps per clone and never commits. If you would
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
