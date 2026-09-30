# Install ynm

Every release ships ynm five ways. They are the same program: the same commands, the same MCP
server (`ynm serve`), the same stores. Pick one by what the machine already has.

## Quickstart

Two commands: install, then set up a repository.

```bash
brew install eyelock/tap/ynm
cd your-repo && ynm init
```

`ynm init` creates the repository's shared memory mount and configures the agent clients the
repository already uses; [Set up your agent clients](#set-up-your-agent-clients) says how it
tells them apart and what each one gets. The rest of this page covers the other ways to install.

| Mechanism | What you get | Size | Needs Node? | Needs git? | Best for |
|---|---|---|---|---|---|
| [Homebrew, standalone](#homebrew-standalone-recommended) | `ynm`, a single executable with Node inside | about 40 MB download, 126 MB installed | No | Yes | Most people on macOS or Linux |
| [Homebrew, slim](#homebrew-slim) | `ynm` as one JavaScript file run by Homebrew's `node` | about 1.4 MB download | Yes (Homebrew's, installed for you) | Yes | Machines that already keep Homebrew's `node` |
| [Direct download of a binary](#direct-download-of-a-binary) | The standalone executable from the release page | 40 to 45 MB download | No | Yes | No Homebrew, CI images, servers |
| [Slim tarball with your own Node](#slim-tarball-with-your-own-node) | `ynm.mjs` and a `bin/ynm` launcher | about 1.4 MB download | Yes, 22.13 or later | Yes | You manage Node yourself (nvm, fnm, a base image) |
| [From source](#from-source) | A checkout you can change | the repository plus `node_modules` | Yes, 22.13 or later, and pnpm | Yes | Working on ynm |
| [Docker image](#docker-image) | The hosted service (`ynm serve --http`) in front of a bare repo | an Alpine image | No | No (inside the image) | Running a hosted store |

Every mechanism needs `git`: memory is stored as git notes. Node 22.13 is the first release with
`node:sqlite` unflagged, which the index uses.

Check any of them the same way:

```bash
ynm --version
```

Expected: `@ynm/cli/<version> <platform> node-v<version>`. For the standalone binary the Node
version is the one built into it.

## Homebrew, standalone (recommended)

```bash
brew install eyelock/tap/ynm
```

The formula picks the binary for your platform (macOS or Linux, arm64 or x86-64) and depends on
`git` only. `brew upgrade ynm` moves to the next release.

## Homebrew, slim

```bash
brew install eyelock/tap/ynm-slim
```

This installs the same program as one bundled JavaScript file and runs it on Homebrew's `node`,
which the formula depends on, whatever `node` comes first on your `PATH`. It is the small
download when Homebrew's `node` is already there. `ynm` and `ynm-slim` both install a `ynm`
executable, so install one of them.

## Direct download of a binary

Release assets are named `ynm_<version>_<os>_<arch>.tar.gz`, with `<os>` `darwin` or `linux` and
`<arch>` `arm64` or `amd64`. Each holds `ynm`, `LICENSE` and `README.md`. `checksums.txt` beside
them lists every asset's SHA-256.

```bash
VERSION=0.1.0
OS=$(uname -s | tr '[:upper:]' '[:lower:]')                       # darwin or linux
ARCH=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')  # arm64 or amd64
ASSET="ynm_${VERSION}_${OS}_${ARCH}.tar.gz"
BASE="https://github.com/eyelock/ynm/releases/download/v${VERSION}"
curl -fsSLO "$BASE/$ASSET"
curl -fsSLO "$BASE/checksums.txt"
grep " $ASSET\$" checksums.txt | shasum -a 256 -c -   # prints "<asset>: OK"
tar -xzf "$ASSET" ynm
chmod +x ynm
mkdir -p ~/.local/bin && mv ynm ~/.local/bin/
export PATH="$HOME/.local/bin:$PATH"                  # add this line to your shell profile
ynm --version
```

On Linux without `shasum`, use `sha256sum -c -` in its place. The macOS binaries are signed ad
hoc, not notarized: a copy downloaded with a browser carries the quarantine attribute and
Gatekeeper refuses it. `curl` does not set that attribute; for a browser download, run
`xattr -d com.apple.quarantine ynm` once.

## Slim tarball with your own Node

`ynm_<version>_slim.tar.gz` holds `ynm.mjs` (the CLI and the MCP server bundled into one file),
`bin/ynm`, `LICENSE` and `README.md`. The launcher runs `ynm.mjs` on the `node` found on your
`PATH`, or on `YNM_NODE` when set, after checking it is 22.13 or later.

```bash
VERSION=0.1.0
BASE="https://github.com/eyelock/ynm/releases/download/v${VERSION}"
curl -fsSLO "$BASE/ynm_${VERSION}_slim.tar.gz"
curl -fsSLO "$BASE/checksums.txt"
grep " ynm_${VERSION}_slim.tar.gz\$" checksums.txt | shasum -a 256 -c -
mkdir -p ~/.local/share/ynm
tar -xzf "ynm_${VERSION}_slim.tar.gz" -C ~/.local/share/ynm
mkdir -p ~/.local/bin && ln -sf ~/.local/share/ynm/bin/ynm ~/.local/bin/ynm
export PATH="$HOME/.local/bin:$PATH"
ynm --version
```

The launcher follows the symlink to find `ynm.mjs`. With an older Node it stops before running
anything:

```text
ynm needs Node 22.13 or later (found v20.11.1); install it or use the standalone binary
```

## From source

Requires Node 22.13 or later and pnpm.

```bash
git clone https://github.com/eyelock/ynm.git
cd ynm
make deps
make install          # writes ~/.ynm/bin/ynm, a launcher for this checkout
export PATH="$HOME/.ynm/bin:$PATH"
ynm --version
```

To build the release artefacts from the checkout, see [Cut a release](cut-a-release.md#build-the-artefacts-locally).

## Docker image

The image is the hosted service, not a desktop install: the MCP server over HTTP in front of a
bare repo under `/data`, with an optional dream worker on a timer.

```bash
docker run -d --name ynm -p 3000:3000 -v ynm-data:/data \
  -e YNM_MCP_TOKEN=change-me -e YNM_DREAM_EVERY=15m ghcr.io/eyelock/ynm
```

Tags are `latest` and each version, for `linux/amd64` and `linux/arm64`. Configuration, auth and
backups are in [Operate a hosted store](operate-a-hosted-store.md); connecting clients to it is in
[Connect a client over HTTP](connect-over-http.md).

## Set up your agent clients

`ynm init` in a repository configures the agent clients that repository already uses. It looks
for three signals, and only one of them makes init write files:

- A **project footprint** (the last column) means the repository uses the client. Init writes that
  client's files.
- An **executable on PATH** or a **user-level footprint** only means the client is on this
  machine. Init writes nothing for it and prints one `also` line naming such clients and
  suggesting `ynm client install <name>`. Add one deliberately with that command.

| Client | Executable on PATH | User-level footprint | Project footprint |
|---|---|---|---|
| Claude Code (`claude-code`) | `claude` | `~/.claude/` or `~/.claude.json` | `.mcp.json` or `.claude/` |
| GitHub Copilot CLI (`copilot-cli`) | `copilot` | `~/.copilot/` | none |
| OpenCode (`opencode`) | `opencode` | `~/.config/opencode/` | `opencode.json` or `opencode.jsonc` |
| Pi (`pi`) | `pi` | `~/.pi/agent/` | `.pi/` |
| ynh (`ynh`) | `ynh` | `~/.ynh/` | `.ynh-plugin/plugin.json` (never acted on by `ynm init`) |

Copilot CLI has no project footprint, so init only ever suggests it. `ynm init --client <name>`
forces a client whatever the signals say.

For each client the project uses, it writes, inside the repository only:

| Client | MCP server | Guidance | Hooks |
|---|---|---|---|
| Claude Code | `.mcp.json` | block in the instruction file Claude reads (see below) | `SessionStart`, `UserPromptSubmit`, `Stop` in `.claude/settings.local.json` (your personal project settings, not the team's `.claude/settings.json`), each running `ynm hook` |
| Copilot CLI | `~/.copilot/mcp-config.json`: printed as a `run:` line, not written | block in `AGENTS.md` | none (Copilot CLI hooks do not fire in untrusted folders) |
| OpenCode | `opencode.json` | block in `AGENTS.md` | none |
| Pi | `.pi/extensions/ynm.ts` (Pi has no MCP; the extension runs the CLI) | `.pi/skills/ynm-memory/SKILL.md` | none |
| ynh, in a harness: via `ynm client install ynh`, not init | `mcp_servers.ynm` in `.ynh-plugin/plugin.json` | a skill include (`github.com/eyelock/ynm`, `skills/ynm-memory`) in the manifest; nothing is copied into the harness | `on_session_start`, `before_prompt`, `on_stop` in the manifest |
| ynh, elsewhere | printed as `run: ynh install github.com/eyelock/ynm --path integrations/ynh` | in that harness | in that harness |

The hooks are what make an agent use ynm rather than its own memory: the session-start hook puts
the memory context block in front of the agent, and the prompt hook, when the user asks it to
remember something, tells it to use `memory_remember`. They are subcommands of the `ynm` binary,
so there is no script to install.

Claude Code's guidance block goes into the instruction file Claude Code actually reads, by its own
lookup, and ynm appends to a file that exists rather than creating a sibling:

| The project has | Claude Code reads | ynm puts the block in |
|---|---|---|
| `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the project directory | those files, not `AGENTS.md` | the one that exists (for example `.claude/CLAUDE.md`), never a new sibling |
| a `CLAUDE.md` that imports `@AGENTS.md` | `CLAUDE.md` and the `AGENTS.md` it pulls in | that `AGENTS.md`, so every client gets it |
| only `AGENTS.md` (or `.claude/AGENTS.md`) | `AGENTS.md` | that file |
| none of these | nothing | a new `AGENTS.md`, which every client reads |

If such a file exists only in a parent directory, Claude reads that and ignores `AGENTS.md`, so ynm
creates a `CLAUDE.md` in the project directory rather than an `AGENTS.md` Claude would not read.
`~/.claude/CLAUDE.md` always loads whatever the project has, so a block already in it counts
as present and ynm adds nothing; `ynm client status` uses the same lookup. Claude Code's hooks go in `.claude/settings.local.json` because
a hook that runs `ynm` would fail for every teammate who lacks it; with `--scope user` they go in
`~/.claude/settings.json`.

### Using a ynh harness

If you run your agents through a ynh harness, the repository needs nothing for the agent to have
ynm. The harness declares ynm's server, hooks and memory skill, and ynh assembles them at every
launch, so they follow you into every repository. Add ynm to the harness once, with
`ynm client install` in the harness directory (the name can be left out there; `ynm client
install ynh` is the same; `ynm init` refuses to install into a harness;
a harness is not a project). Without `ynm init` in a repository, the agent's memory goes to your
personal store. Run `ynm init --no-clients` in a repository only to add shared, team memory: the
flag keeps init from also writing `.mcp.json`, an instruction file and hooks that would duplicate what
the harness already provides.

`ynm init --no-clients` skips the step; `ynm init --client claude-code` configures only the
clients you name, whether the project uses them or not. `ynm client install` is the manual form,
with `--scope user` for a user-wide install and `--no-hooks` to leave the hooks out. The client
name is optional: in a ynh harness directory it means ynh, and anywhere else every client the
project uses (a project footprint; with none, the command exits 2 with `no agent client is
configured in <dir>; name one`). Name a client to install one the project does not use yet. When
everything is already in place it prints `already in place, nothing changed:` followed by a line
for each piece it found (server, guidance, hooks) and where. `ynm validate [dir]`
checks a ynh harness, or the clients a project uses, and prints every check (server, guidance,
hooks, and `ynm` on the PATH) with `ok` or `FAIL`, exiting 1 when something is missing.
`ynm client status` and `ynm doctor` report, per client, whether the server, the guidance and the hooks are
in place. [Tutorial 7](../tutorial/07-connect-an-agent.md) walks through all of it.

## Next

[Tutorial 1: First memory](../tutorial/01-first-memory.md).
