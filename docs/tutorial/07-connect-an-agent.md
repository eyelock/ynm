# Connect an Agent

Let `ynm init` wire ynm into the agent clients your repository already uses, see exactly which
files each one gets, watch the hooks that put memory in front of the agent at the right moment, then talk to the MCP server
yourself with a short script, the way an agent does.

## Prerequisites

`ynm` is on your PATH. This tutorial writes client configuration into a throwaway project. One
client, Copilot CLI, keeps its configuration in your home directory, so for that one we only
print the plan and never install it. Prepare the sandbox, a personal store, and a repository
with one commit:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
export YNM_NO_CLAUDE_CLI=1
cd /tmp/ynm-tutorial
ynm init --personal
git init -q -b main project
cd project
git -c user.name=tutorial -c user.email=tutorial@example.com commit -q --allow-empty -m "first commit"
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git` and nothing else.

## One command: `ynm init`

`ynm init` sets up the repository (tutorial 2) and then configures the agent clients the
repository already uses. It looks for three signals, and only one of them makes init write
anything:

- A project footprint, a file or folder the repository already has for that client, is the
  signal that the project uses it. Init writes that client's files.
- An executable on your PATH, or a user-level footprint in your home directory, only says the
  client is on this machine. Init writes nothing for it and adds one `also` line suggesting
  `ynm client install <name>`, so it never adds a client's configuration to a repository that
  does not use that client.

| Client | Executable on PATH | User-level footprint | Project footprint |
|---|---|---|---|
| `claude-code` | `claude` | `~/.claude/` or `~/.claude.json` | `.mcp.json` or `.claude/` |
| `copilot-cli` | `copilot` | `~/.copilot/` | none |
| `opencode` | `opencode` | `~/.config/opencode/` | `opencode.json` or `opencode.jsonc` |
| `pi` | `pi` | `~/.pi/agent/` | `.pi/` |
| `ynh` | `ynh` | `~/.ynh/` | `.ynh-plugin/plugin.json` |

Copilot CLI has no project footprint, so init only ever suggests it. ynh is never configured by
`ynm init`; a harness gets ynm with `ynm client install ynh` (see the end of this tutorial).

This throwaway project has no footprint for any client yet, so a plain `ynm init` would write no
client files and, depending on what is installed on your machine, print an `also` line. To see
a client configured, `--client` forces one, and the output is the same everywhere:

```bash
ynm init --client claude-code
```

Expected: the `initialised` report from tutorial 2, including the note that remote `origin` was
not found, then one `client` line saying what was written for Claude Code: its server entry,
the guidance block and three hooks.

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

Claude Code now has a project footprint, `.mcp.json` and `.claude/`, so from here a plain
`ynm init` treats this project as one that uses it:

```bash
ynm init
```

Expected: the same report, now with the config marked `(unchanged)`, `client    claude-code:
unchanged`, and, for clients found only on your machine, one `also` line:

```text
initialised <project path>
  anchor    <40-hex sha> (root-commit)
  config    <project path>/.ynm/config.json (unchanged)
  note      remote "origin" not found; refspecs not configured (re-run init after adding it)
  client    claude-code: unchanged
  also      copilot-cli, pi on this machine but not used here; add one with `ynm client install <name>`
next: `ynm remember --type semantic --content "..."` and `ynm doctor`
```

The `also` line names whichever other clients your machine has, so yours may name different
ones or be absent. Without `--client`, you get one `client` line per client the project uses
and at most that one `also` line. `--no-clients` skips the step. Init only writes inside the work
tree: a client whose install needs a file in your home directory (Copilot CLI) gets a `run:`
line to do yourself instead.

## What Claude Code got

The server entry, which Claude Code uses to start `ynm serve` over stdio whenever it opens the
project:

```bash
cat .mcp.json
```

Expected:

```text
{
  "mcpServers": {
    "ynm": {
      "command": "ynm",
      "args": [
        "serve"
      ]
    }
  }
}
```

The guidance block tells the agent how to use memory:

```bash
cat CLAUDE.md
```

Expected: a Markdown block between two `<!-- ynm:guidance -->` marker lines, headed
`# Using memory in this session`, with six numbered rules: start with `memory_context` or
`memory_recall`, remember durable facts, keep `personal` unless the fact is safe for the team,
supersede rather than duplicate, use ynm rather than the client's own note files, and stay quiet
about it. ynm only ever rewrites the text between the markers, so anything else you keep in the
file is safe, and installing again is harmless.

The hooks, in the project's personal Claude Code settings. They go in
`.claude/settings.local.json`, the file Claude Code keeps for you and does not commit, and never
in the team's tracked `.claude/settings.json`: a hook that runs `ynm` would fail for every
teammate who does not have it installed.

```bash
cat .claude/settings.local.json
```

Expected: three events, each running a `ynm hook` subcommand:

```text
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ynm hook session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ynm hook prompt"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "ynm hook stop"
          }
        ]
      }
    ]
  }
}
```

If the file already had hooks or other settings, ynm adds its three entries beside them and
never adds one twice, and it keeps the file's indentation and trailing newline. `ynm client
status` counts hooks found in any of `.claude/settings.local.json`, `.claude/settings.json` or
`~/.claude/settings.json`, so a team that put them in the shared file on purpose still shows
`hooks yes`.

## What the hooks do

Claude Code runs each hook with a JSON object on stdin and reads JSON from stdout. You can play
Claude Code's part. Remember something first, then send the hook what Claude Code sends when a
session starts:

```bash
ynm remember --type semantic --content "The user likes to be called Dee."
echo '{"session_id":"tutorial-session","cwd":"'"$PWD"'","hook_event_name":"SessionStart","source":"startup"}' | ynm hook session-start
```

Expected: `remembered <id> in personal`, then one line of JSON. Its `additionalContext` is the
context block from tutorial 3, prefixed by one line telling the agent to use ynm; Claude Code
adds it to the agent's context before the first prompt:

```text
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"ynm memory for this session (use memory_recall for more; use memory_remember to keep facts, not note files):\n\n## Memory\n- (semantic) The user likes to be called Dee."}}
```

The prompt hook watches for the moment the user asks the agent to remember something, which is
when a client's built-in memory would otherwise take over:

```bash
echo '{"session_id":"tutorial-session","hook_event_name":"UserPromptSubmit","prompt":"Remember that I prefer tabs."}' | ynm hook prompt
echo '{"session_id":"tutorial-session","hook_event_name":"UserPromptSubmit","prompt":"Make parse() always return a list."}' | ynm hook prompt
```

Expected: for the first prompt, a nudge toward `memory_remember`; for the second, where
"always" is part of an instruction about code, nothing but `{}`:

```text
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"The user is asking you to remember something. Store it with memory_remember (ynm), not in a note file or memory directory. Prefer memory_supersede if a memory on this already exists."}}
{}
```

The stop hook runs at the end of every turn. It expires the session's due working memory
(tutorial 5) and answers `{}`:

```bash
echo '{"session_id":"tutorial-session","hook_event_name":"Stop"}' | ynm hook stop
```

Expected: `{}`. A hook never fails the session: empty or broken input, or any error, still
prints `{}` and exits 0, with the error on stderr.

## Status and the manual form

`ynm client status` checks every supported client without changing anything:

```bash
ynm client status
```

Expected: five lines, one per client. Claude Code is `ok` with everything in place:

```text
ok   claude-code: server yes, guidance yes, hooks yes; project scope: <project path>/.mcp.json
```

The other four lines depend on your machine: `--   <client>: not detected`, or, for a client
detected by one of the signals above, `detected (...)` naming the signals and the command that
would install it.

`ynm client install <name>` is the manual form of what init did, one client at a time, with a
`plan` to preview it. For Claude Code there is nothing left to do, and `ynm init` again reports
it unchanged:

```bash
ynm client plan claude-code
ynm init --client claude-code
```

Expected: `nothing to do`, then the `initialised` report with the config marked `(unchanged)`
and `client    claude-code: unchanged`, plus an `also` line if other clients are on your machine.

`ynm client install claude-code --scope user` registers the server for every project with
`claude mcp add` and merges the hooks into `~/.claude/settings.json`; `--no-hooks` leaves the
hooks out.

## The other clients

Each client has its own idea of where configuration lives. Copilot CLI reads only a file in
your home directory, so here we only look at the plan:

```bash
ynm client plan copilot-cli
```

Expected: two changes, a `merge-json` of `<home>/.copilot/mcp-config.json` (Copilot CLI's
user-level file, the only one it reads) and a `write` of `<project path>/AGENTS.md`, the
guidance block. `ynm client install copilot-cli` would apply them, and it changes your real
home directory, which is why the tutorial stops at the plan. The file gets the same `ynm serve`
command under `mcpServers`, plus `"type": "local"` and `"tools": ["*"]`. Copilot CLI gets no
hooks: its hooks do not fire in folders the CLI has not marked as trusted.

OpenCode reads `opencode.json` in the project and shares `AGENTS.md` for the guidance:

```bash
ynm client install opencode
cat opencode.json
```

Expected: `merged <project path>/opencode.json` and `wrote <project path>/AGENTS.md`. The file
registers the same server in OpenCode's own shape:

```text
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "ynm": {
      "type": "local",
      "command": [
        "ynm",
        "serve"
      ],
      "enabled": true
    }
  }
}
```

Pi has no MCP support, so ynm gives it an extension whose tools run the `ynm` CLI instead:

```bash
ynm client install pi
find .pi -type f | sort
```

Expected: `wrote` lines for the extension and the skill, then the two files:

```text
.pi/extensions/ynm.ts
.pi/skills/ynm-memory/SKILL.md
```

`ynm.ts` is generated; its first line says so and names `pnpm gen:clients`. Every `memory_*`
tool in it shells out to `ynm <command> --json`, so `ynm` must be on the PATH Pi runs with. The
skill carries the same guidance text as the `CLAUDE.md` block.

## Install into a ynh harness

ynh, the harness manager, assembles one declaration for every vendor it supports. A harness is
not a project: it has no memory of its own, so `ynm init` never installs into one. You add ynm
to a harness explicitly, with `ynm client install ynh`. Make a minimal harness, a manifest with
just a name and a version, and first see what `ynm init` says there. It exits non-zero, so the
step ends in `|| true`:

```bash
mkdir -p /tmp/ynm-tutorial/harness/.ynh-plugin
cd /tmp/ynm-tutorial/harness
echo '{"name": "my-harness", "version": "0.1.0"}' > .ynh-plugin/plugin.json
ynm init || true
```

Expected: an error, and nothing written. (A repository that happens to hold a harness
manifest, such as ynh's own repository, is different: init treats it as a project and leaves the
manifest untouched.)

```text
Error: <harness path> is a ynh harness, not a project: memory is initialised in the repositories you work on. To add ynm to this harness run `ynm client install ynh`
```

Now do what it says:

```bash
ynm client install ynh
```

Expected: the manifest written, then the check to run:

```text
wrote /tmp/ynm-tutorial/harness/.ynh-plugin/plugin.json
next: ynd validate .
```

The merged manifest, and what else is in the harness:

```bash
cat .ynh-plugin/plugin.json
find . -type f | sort
```

Expected: the manifest gained the schema reference, the server, an include of ynm's memory
skill, and three hooks under ynh's canonical event names, which ynh translates per vendor (for
Claude Code: `SessionStart`, `UserPromptSubmit`, `Stop`). The skill is an include, not a copy:
ynh fetches `skills/ynm-memory` from ynm's repository and keeps it current, so nothing is
written into the harness's own `skills/`, and the manifest is the only file:

```text
{
  "$schema": "https://eyelock.github.io/ynh/schema/plugin.schema.json",
  "name": "my-harness",
  "version": "0.1.0",
  "mcp_servers": {
    "ynm": {
      "command": "ynm",
      "args": [
        "serve"
      ]
    }
  },
  "includes": [
    {
      "git": "https://github.com/eyelock/ynm",
      "pick": [
        "skills/ynm-memory"
      ]
    }
  ],
  "hooks": {
    "on_session_start": [
      {
        "command": "ynm hook session-start"
      }
    ],
    "before_prompt": [
      {
        "command": "ynm hook prompt"
      }
    ],
    "on_stop": [
      {
        "command": "ynm hook stop"
      }
    ]
  }
}
./.ynh-plugin/plugin.json
```

With ynh's developer tool installed, `ynd validate .` reports `.: valid`. Installing again
reports `nothing to do`. The merge keeps whatever indentation and trailing newline the manifest
already had, so it does not rewrite the rest of the file. Outside a harness,
`ynm client install ynh` prints `run: ynh install github.com/eyelock/ynm`, which installs ynm's
own harness with the same hooks.

Once a harness carries ynm, the repositories you work on need nothing for the agent to have it:
ynh assembles the server, the hooks and the skill at every launch, and memory goes to your
personal store. Run `ynm init --no-clients` in a repository only to add shared, team memory; the
flag keeps init from also writing `.mcp.json`, `CLAUDE.md` and hooks that duplicate the harness.

Back to the project for the rest of the tutorial:

```bash
cd /tmp/ynm-tutorial/project
ynm client status
```

Expected: `ok` for `claude-code`, `opencode` and `pi`, each followed by the path of what was
written; `hooks n/a` for OpenCode and Pi, which get no hooks; the `copilot-cli` and `ynh` lines
as before. The `ynh` line is not `ok` here: this project is not a harness.

## Serve

`ynm serve` is what every client launches. It speaks MCP on stdin and stdout by default, which
is why you rarely run it by hand except to see its options:

```bash
ynm serve --help
```

Expected: usage for `ynm serve`, with the flags `--http`, `--port`, `--host`, `--token`,
`--no-personal`, `--dream-every` and `--sync-every` among others. Tutorial 10 uses the HTTP
mode.

## Talk to it yourself

An MCP client sends JSON-RPC messages, one per line, and reads the answers. The script below is
the whole client: it starts `ynm serve` in the current directory, does the handshake, lists the
tools and calls `memory_recall`. First give the store something to find:

```bash
ynm remember --type semantic --content "Deploys happen on Tuesdays." --tags deploy
ynm remember --type procedural --level distributed --content "Run pnpm check before pushing." --tags ci
```

Expected: `remembered <id> in personal`, then `remembered <id> in project`.

Write the script and run it:

```bash
mkdir -p /tmp/ynm-tutorial/work
cat > /tmp/ynm-tutorial/work/mcp-call.mjs <<'JS'
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// The sandbox variables are spelled out so this script can only ever reach the sandbox store.
const env = { ...process.env, YNM_HOME: "/tmp/ynm-tutorial/home", YNM_USER: "tutorial" };
const server = spawn("ynm", ["serve"], { env, stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined) pending.get(msg.id)?.(msg);
});
let nextId = 1;
const send = (message) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "tutorial", version: "0" },
});
send({ method: "notifications/initialized" });

const tools = await request("tools/list", {});
console.log(tools.result.tools.map((t) => t.name).join("\n"));

const hits = await request("tools/call", { name: "memory_recall", arguments: { text: "deploy" } });
console.log(JSON.stringify(hits.result.structuredContent, null, 2));
server.stdin.end();
JS
node /tmp/ynm-tutorial/work/mcp-call.mjs
```

Expected: first the ten tool names, one per line:

```text
memory_remember
memory_recall
memory_context
memory_supersede
memory_annotate
memory_forget
memory_session
memory_consolidate
memory_sync
memory_status
```

Then the recall result: a JSON object with a `data` array holding one hit, the Tuesday memory,
with the same fields as `ynm recall --json` (`memoryId`, `mount` set to `personal`, `score`,
`content` and the rest), and `"guidance": null`.

This is the data the CLI printed in tutorial 1: the CLI and the MCP tools are two front ends over
one service, generated from the same schemas. Note what the tools leave out. `purge`, `export`,
`import` and `pin` are CLI-only, on purpose, so an agent cannot destroy history.

If you would rather not hand-write the protocol, the official client does the handshake for
you. Install `@modelcontextprotocol/client` in a project of your own and use:

```js
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "tutorial", version: "0" });
await client.connect(new StdioClientTransport({ command: "ynm", args: ["serve"] }));
console.log((await client.listTools()).tools.map((t) => t.name));
console.log(await client.callTool({ name: "memory_recall", arguments: { text: "deploy" } }));
await client.close();
```

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER YNM_NO_CLAUDE_CLI
```

Next: tutorial 8, dreaming, where ynm tidies its own memory.
