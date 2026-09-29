# Connect an Agent

Wire ynm into the agent clients it supports, see exactly which files each one gets, then talk to
the MCP server yourself with a short script, the way an agent does.

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
ynm init
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git`, then the `initialised`
report from tutorial 2, including the note that remote `origin` was not found.

## What is installed

`ynm client status` checks every supported client without changing anything:

```bash
ynm client status
```

Expected: five lines, one per client. In the empty sandbox `claude-code`, `opencode` and `pi`
are marked `--` for "not configured":

```text
--   claude-code: ynm not registered; run `ynm client install claude-code`
--   opencode: ynm not registered; run `ynm client install opencode`
--   pi: extension not installed; run `ynm client install pi`
```

The `copilot-cli` line reflects your real home directory, so it depends on whether you already
use ynm with Copilot CLI. The `ynh` line reads `ynh not installed` unless you have the `ynh`
binary on your PATH.

## Claude Code: plan, then install

`plan` prints what an install would change and touches nothing:

```bash
ynm client plan claude-code
```

Expected: two changes. The MCP server is merged into the project's `.mcp.json`, and a
guidance block is written to `CLAUDE.md`.

```text
merge-json <project path>/.mcp.json  (register the ynm MCP server for this project)
write      <project path>/CLAUDE.md  (memory guidance for the agent (delimited block))
```

Apply it:

```bash
ynm client install claude-code
cat .mcp.json
```

Expected: `merged <project path>/.mcp.json` and `wrote <project path>/CLAUDE.md`, then the
server entry. Claude Code starts `ynm serve` over stdio whenever it opens the project:

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

The `CLAUDE.md` block tells the agent how to use memory:

```bash
cat CLAUDE.md
```

Expected: a Markdown block between two `<!-- ynm:guidance -->` marker lines, headed
`# Using memory in this session`, with five numbered rules: start with `memory_context` or
`memory_recall`, remember durable facts, keep `personal` unless the fact is safe for the team,
supersede rather than duplicate, and stay quiet about it. ynm only ever rewrites the text between
the markers, so anything else you keep in the file is safe, and installing again is harmless.

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
command under `mcpServers`, plus `"type": "local"` and `"tools": ["*"]`.

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

`ynh`, the harness manager, installs ynm as a plugin, using a command rather than files. Without
`--yes` ynm prints the command and does not run it:

```bash
ynm client install ynh
```

Expected:

```text
run: ynh install github.com/eyelock/ynm
```

Now the status shows what is configured:

```bash
ynm client status
```

Expected: `ok` for `claude-code`, `opencode` and `pi`, each followed by the path
of what was written; the `copilot-cli` and `ynh` lines are as before.

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
