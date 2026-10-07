# ADR-016: Agent guidance delivery: hooks and one-command client setup

Status: accepted (2026-09-30)
Satisfies: FR-20, FR-20a, FR-21, NFR-14

## Context

ynm's guidance, when to remember, when to recall, supersede rather than duplicate, is authored
once in `packages/model/src/guidance/` (ADR-013). Having it written down is not the same as the
agent acting on it. A user declared ynm's MCP server in a ynh harness, launched Claude Code and
asked it to remember their preferred name; the agent wrote the fact into Claude Code's own
memory directory. The server was connected, no guidance was loaded, and nothing reached the
model at the moment it decided where to put the fact. `ynm client install claude-code` then
wrote `.mcp.json` and a `CLAUDE.md` block and nothing else, and a new user had to run
`ynm init` and then one `ynm client install` per client. Two lessons: guidance must arrive at
the moment the client's built-in memory would otherwise win, and setup must be one command.

Guidance can reach an agent through four channels:

| Channel | What ynm ships | When the model sees it | Who controls it |
|---|---|---|---|
| MCP | server `instructions`, three prompts, tool descriptions | when the client chooses to load them; many never surface prompts or instructions | the client |
| Instruction files | a delimited block in `CLAUDE.md` or `AGENTS.md` | at session start, among everything else in the file | the client, and the user's edits |
| Skills | `ynm-memory` skill (ynh, Pi, OpenCode) | when the model decides the skill is relevant | the model |
| Hooks | `ynm hook session-start`, `prompt`, `stop` | on the event, every time, as `additionalContext` | the harness, deterministically |

The first three are advisory and compete with the client's own memory feature on equal or
worse terms. Only a hook runs when the event happens whatever the model thinks: at session start
it puts the memory context block in front of the agent, and when the user says "remember" it
adds one sentence naming `memory_remember`, at exactly the turn the client would otherwise
reach for its note file.

## Decision

**Hooks are subcommands of the binary.** `ynm hook <event>` reads the client's hook JSON on
stdin and prints the client's reply JSON on stdout. Nothing is installed but a config line that
runs `ynm hook ...`; there is no script to copy, version or keep executable, and the hooks
upgrade with the binary.

- `session-start` starts an ynm session keyed by the client's `session_id` (normalised the way
  `memory_session start` does) and returns the context block, default budget, as
  `hookSpecificOutput.additionalContext`, prefixed by one line: use `memory_recall` for more, use
  `memory_remember` to keep facts, not note files.
- `prompt` returns a one-sentence nudge toward `memory_remember` (and `memory_supersede`) when
  the prompt shows a remember intent: one of `remember`, `don't forget`, `from now on`,
  `always`, `never`, `call me`, `my preference`, `note that` at the start of a clause or after
  "please". The phrase list is one exported constant with a unit test of true and false
  positives. A false positive costs the model one sentence; a miss costs the memory.
- `stop` expires the session's due working memory with the expire pass alone, never the
  model-backed engine. Claude Code fires Stop at the end of every turn, so it is idempotent, and
  a per-session stamp under `$YNM_HOME/hooks/` limits the pass to once every five minutes.
- The contract is Claude Code's (Codex shares it): stdin carries `session_id`, `cwd`,
  `hook_event_name`, and per event `prompt` or `source`; stdout is
  `{"hookSpecificOutput": {"hookEventName", "additionalContext"}}` or `{}`. A hook never blocks
  and never fails the session: empty or non-JSON input, an unknown event or any error prints
  `{}`, exits 0, and writes the error to stderr. stdout carries nothing but the one JSON line.
- The launcher answers `ynm hook` before loading oclif, and the store-free parts (event names,
  parsing, the intent test) live in a module with no imports (`@ynm/service/hook-intent`), so
  the prompt hook and a throttled stop start in about the time Node itself takes.

**Clients get the hooks where they fire.** `ynm client install claude-code` merges
`SessionStart`, `UserPromptSubmit` and `Stop` entries into `.claude/settings.local.json`
(project) or `~/.claude/settings.json` (user), keeping other hooks and keys and never adding an
entry whose command is already there; `--no-hooks` skips them. The project file is Claude Code's
personal project settings, never the team's tracked `.claude/settings.json`: a hook that runs
`ynm` fails for every teammate who does not have it installed. Status counts hooks found in any
of the three files, so a team that put them in the shared file on purpose still reads `hooks
yes`. In a ynh harness (the directory holds `.agents/harness/plugin.json`) `ynm client install ynh`
merges the server, the canonical hooks `on_session_start`, `before_prompt` and `on_stop`, and an
include of the skill, `{ "git": "https://github.com/eyelock/ynm", "path": "integrations", "pick": ["skills/ynm-memory"] }`,
into the manifest. Nothing is copied into the harness's `skills/`: ynh resolves the include and
keeps it current, the way it does any other skill. ynm's own generated harness declares the same
three hooks, so `ynh install github.com/eyelock/ynm --path integrations/ynh` carries them. ynh translates the canonical
names per vendor (`SessionStart`, `UserPromptSubmit`, `Stop` on Claude Code and Codex).

Claude Code's guidance block goes into the instruction file Claude Code actually reads, by its
own lookup (`claude-instructions.ts`). At launch Claude loads `CLAUDE.md`, `.claude/CLAUDE.md`
and `CLAUDE.local.md` from the working directory and every directory above it; only when none
exist does it load `AGENTS.md` and `.claude/AGENTS.md`. A `CLAUDE.md` that imports `@AGENTS.md`
pulls that file in either way, and `~/.claude/CLAUDE.md` always loads. ynm appends its delimited
block to an existing file in the project directory, preferring the `AGENTS.md` a `CLAUDE.md`
imports (every client then gets it), else the `CLAUDE.md` family file that is there, else an
existing `AGENTS.md`, else, when `CLAUDE.md` files exist only above the project, a new `CLAUDE.md` there; it never creates a sibling beside a file Claude already reads. Only when
the project has no instruction file does it create `AGENTS.md`, which every client reads. A block
already present in any file Claude loads, the user's included, counts, and status uses the same
lookup.

JSON merges preserve the target file's style: its indentation, its `\uXXXX` escapes (a manifest
full of `\u2014` stays that way) and its trailing newline, so a merge changes only the lines it
adds.

**`ynm init` is the one command.** After the repository setup of ADR-009, `ynm init` applies the
project-scope install (server entry, guidance and hooks) of each client the project already
uses. A client is found by three signals, but only one of them makes init write files:

| Client | Executable on PATH | User-level footprint | Project footprint |
|---|---|---|---|
| claude-code | `claude` | `~/.claude/`, `~/.claude.json` | `.mcp.json`, `.claude/` |
| copilot-cli | `copilot` | `~/.copilot/` | none (`AGENTS.md` is shared) |
| opencode | `opencode` | `~/.config/opencode/` | `opencode.json`, `opencode.jsonc` |
| pi | `pi` | `~/.pi/agent/` | `.pi/` |
| ynh | `ynh` | `~/.ynh/` | `.agents/harness/plugin.json` |

A project footprint means the repository uses the client, and init configures it. The other two
signals only say the client is on this machine; init writes nothing for such a client and
prints one `also` line naming all of them and suggesting `ynm client install <name>`, so init never adds a client's configuration to a
repository that does not use it. Copilot CLI, which has no project footprint, is therefore only
ever suggested. PATH is scanned for the file, never by running it, and `detect` takes the
environment so tests drive it.

Init never installs into a ynh harness. A harness is not a project: it has no memory of its own,
and a repository that holds a harness manifest (ynh's own) may be a harness product rather than
a harness to install into. In a directory that is a harness and not a git repository init fails
with `<path> is a ynh harness, not a project`, a note that memory is initialised in the
repositories you work on, and the command to run, `ynm client install ynh`. A git repository that holds a
manifest is initialised as a project and the manifest is left untouched. The harness route is
always explicit, `ynm client install ynh`; once a harness carries ynm, the repositories used
through it need nothing for the agent to have ynm, and `ynm init --no-clients` there adds only
shared memory without writing files that duplicate the harness.

Init writes only inside the work tree: a change to a file under the home directory (Copilot
CLI's only config file) or a command becomes a `run:` line in the report. It prints one `client`
line per client the project uses, at most one `also` line, and nothing for the rest; a second
run reports `unchanged`. `--no-clients` skips the step and `--client <name>` names the clients
to configure, used by the project or not. A bare repository gets no client files. `ynm client
install` stays as the manual, per-client form with `--scope user` and `--http`. Its client name
is optional: in a ynh harness directory it means ynh, otherwise every client the project uses
(none: exit 2, naming the clients to choose from). When nothing changes it says
`already in place, nothing changed:` and lists each piece it found and where, rather than
reporting nothing.

**Status sees the gap.** Each adapter's status reports whether the server is registered, whether
the guidance is present and whether ynm's hooks are installed (absent for a client ynm installs
none in). `ynm client status` prints the three per client, and `ynm doctor` adds one line per
detected client, a `warn` naming `ynm client install <client>` when the server is registered
but guidance or hooks are missing.

## Not done

- **Copilot CLI hooks.** Copilot CLI's hooks do not fire in folders the CLI has not marked
  trusted, and no flag grants that trust per invocation (ynh's vendor notes record the same and
  emit no Copilot hook config). ynm installs none rather than something that looks wired and is
  inert.
- **OpenCode and Pi hooks.** Their lifecycle events belong to plugins and extensions rather than
  command hooks. Pi's generated extension could subscribe to session events later; neither gets
  hooks today, and status reports `hooks n/a`.
- **`ynh run` with Claude Code.** ynh passes the assembled plugin with `--plugin-dir`, which
  activates skills and commands but not hooks or MCP servers until the plugin is installed with
  `/plugin install` (a Claude Code limitation ynh documents). The harness declarations are
  correct and work with Codex and Cursor, and in a plain Claude session through
  `.claude/settings.local.json`, which is what `ynm init` writes for claude-code.
- **Hosted servers.** The hooks run the local binary against the local store. With `--http` the
  prompt nudge works unchanged, but session start shows only local memory.
- **Tracked files.** ADR-009's promise that init changes no tracked file holds for memory. The
  client step can edit a tracked `CLAUDE.md`, `AGENTS.md`, `.mcp.json` or `opencode.json` by merge
  or delimited block, keeping the file's style; the hooks go to the untracked
  `.claude/settings.local.json`. `--no-clients` keeps init to memory alone.

## Alternatives considered

- Hook scripts shipped as files and copied into each project. Rejected: another artefact to
  install, version and keep executable per client, and one more thing to go stale when the
  binary upgrades.
- Guidance through MCP alone (server instructions, prompts). Rejected as the only channel: it is
  kept, but clients surface it inconsistently and never at the moment of a remember request.
- Install every client's user-level config from init. Rejected: init runs in a repository and
  should change that repository; user-wide changes stay explicit (`ynm client install --scope
  user`).

## Consequences

- `make test` covers the hook contract end to end (the built CLI with stdin fixtures), the
  intent list's true and false positives, the settings and manifest merges (golden file for
  Claude Code's settings), detection from each signal, and init's client step, including a
  second run that changes nothing.
- The tutorials show init's `also` line, which depends on the machine; tutorial 7 pins its
  output with `--client claude-code` and pipes a fake SessionStart into `ynm hook`.
- A hook on the client's clock costs about 50 ms of Node start-up for the prompt hook and a
  throttled stop, and about 140 ms for a stop that runs the expire pass or a session start, on a
  checkout build. The release bundle parses the whole program first, so its hooks cost more
  until Node's compile cache is used.

## History

- 2026-09-30: hooks as `ynm hook` subcommands, installed by the claude-code and ynh adapters;
  `ynm init` configures detected clients; status and doctor report guidance and hooks.
- 2026-09-30: before release, init narrowed to clients a project uses; harness install made
  explicit and by include; project hooks moved to settings.local.json (first real use, in the ynh
  repository)
- 2026-09-30: ynm's shipped artefacts moved under `integrations/`; there is one client-neutral
  `ynm-memory` skill at `integrations/skills/`, which harnesses include with
  `path: integrations` (an older ynm include is replaced in place) and Pi installs.
- 2026-10-01: the MCP channel made as strong as it can be for clients connected by URL alone:
  server instructions built from the levels the server serves and naming the remember-intent
  phrases, `memory_remember`, `memory_recall` and `memory_context` descriptions that claim the
  job over built-in memory, and a level-less remember that is distributed when no personal mount
  is open. Hooks remain the deterministic channel.
- 2026-10-07: ynh's harness manifest moves to `.agents/harness/plugin.json`, ynh's canonical layout; `.ynh-plugin/` is no longer written (an existing one is moved there by `ynm client install ynh`). Accepted.
