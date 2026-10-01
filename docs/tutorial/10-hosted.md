# Hosted Service

Run ynm as a server: one process in front of one bare repository, speaking MCP over HTTP with a
bearer token. Agents connect with nothing but a URL and a token; they never need git. You will
start it, check its health, be refused without the token, make MCP calls with curl, and see the
result land in the repository.

## Prerequisites

`ynm` is on your PATH, and `curl`. Prepare the sandbox and the store the server will front, a
bare repository with ynm initialised in it:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
export YNM_NO_CLAUDE_CLI=1
cd /tmp/ynm-tutorial
ynm init --bare /tmp/ynm-tutorial/store.git
ynm init --cwd /tmp/ynm-tutorial/store.git
```

Expected: `created bare memory repo /tmp/ynm-tutorial/store.git (anchor <12-hex sha>)`, then an
`initialised <path>` report whose anchor is the same commit. A bare repo has no code to anchor
to, so `init --bare` creates a root commit for the purpose. It has no work tree for an agent to
open either, so the report has no `client` lines: `ynm init` configures agent clients only in a
checkout. Clients reach this store over HTTP instead, as below and in
[Connect a client over HTTP](../how-to/connect-over-http.md).

## Start the server

`--http` switches from stdio to Streamable HTTP. `--no-personal` mounts no personal store, which
is what you want on a shared server. `--token` is a static bearer token, fine for a demo. The
server goes in the background, and we wait until it answers:

```bash
ynm serve --http --port 3999 --token demo --no-personal --cwd /tmp/ynm-tutorial/store.git > /tmp/ynm-tutorial/serve.log 2>&1 &
echo $! > /tmp/ynm-tutorial/serve.pid
until curl -sf http://localhost:3999/health > /dev/null; do sleep 0.5; done
cat /tmp/ynm-tutorial/serve.log
```

Expected: the server's own log, two lines.

```text
ynm-mcp listening on http://localhost:3999/mcp (health: http://localhost:3999/health)
ynm-mcp auth: bearer
```

## Health

`/health` is outside authentication, so a load balancer can poll it:

```bash
curl -s http://localhost:3999/health
```

Expected: one line of JSON. It names the auth mode and reports the background workers, which
have not run since we did not ask for any.

```text
{"status":"ok","name":"ynm","auth":"bearer","scheduler":{"dreamRuns":0,"syncRuns":0,"lastDreamAt":null,"lastSyncAt":null,"lastError":null,"lastDream":null}}
```

## No token, no entry

Everything else answers only to the token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3999/mcp -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3999/mcp -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{}'
```

Expected: `401` twice. The response carries a standard `WWW-Authenticate: Bearer` challenge, with a
description of "Missing Authorization header" in the first case and "invalid token" in the
second, so a real MCP client knows to authenticate.

## Talk MCP with a token

The endpoint is `/mcp`. Each request is a JSON-RPC message sent as a POST, and the answer
comes back as a server-sent event whose `data:` line holds the JSON. This server is stateless,
so there is no session to open: initialise once to see what it offers, then call tools.

```bash
curl -s -X POST http://localhost:3999/mcp -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | grep '^data:' | cut -c7-
```

Expected: one line of JSON whose `result` names the server (`"serverInfo":{"name":"ynm","version":"0.1.0", ...}`),
its capabilities (tools, resources and prompts) and an `instructions` string telling an agent to
read `memory_context` first and to prefer `memory_supersede` over duplicates.

Now write and read a memory:

```bash
curl -s -X POST http://localhost:3999/mcp -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_remember","arguments":{"type":"semantic","level":"distributed","content":"The hosted store answers on port 3999."}}}' | grep '^data:' | cut -c7-
curl -s -X POST http://localhost:3999/mcp -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_recall","arguments":{"text":"hosted store"}}}' | grep '^data:' | cut -c7-
```

Expected: two lines of JSON. The first is the result of `memory_remember`: its
`structuredContent` holds a new `memoryId`, `"mount":"project"` and a `revision` sha. The second
is `memory_recall`, whose `structuredContent.data` is an array with one hit, the memory you just
wrote, with `"level":"distributed"` and `"namespace":"common"`. Any MCP client library, such as
`@modelcontextprotocol/client` with its HTTP transport, does the same thing with the framing
handled for you.

## See it land in the repository

The server is the only writer, but the store is an ordinary git repository. Read it from the
CLI and from git itself:

```bash
ynm list --level distributed --cwd /tmp/ynm-tutorial/store.git
git -C /tmp/ynm-tutorial/store.git for-each-ref --format='%(refname)'
```

Expected: the one memory, then two refs, the anchor branch and the shard the server wrote:

```text
<id>  semantic   distributed common                   The hosted store answers on port 3999.
refs/heads/main
refs/notes/ynm/distributed/common/semantic/<yyyy-mm>
```

A developer clone of this repository would fetch that ref with `ynm sync`, exactly as in
tutorial 6. The agent that wrote it needed no git.

## Stop the server

```bash
kill $(cat /tmp/ynm-tutorial/serve.pid)
sleep 1
curl -s -m 2 http://localhost:3999/health || echo "server stopped"
```

Expected: `server stopped`.

## The Docker demo

The repository ships a full demonstration in containers: a store, an agent client that speaks HTTP
with no git, and a developer clone that syncs through the store. It needs Docker and a
checkout of the repository, and it takes a few minutes to build. Set
`DOCKER_HOST_AVAILABLE=1` in your shell to run it, then run the script from the checkout's
root.

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
infra/docker/demo.sh
```

Expected: three headed sections, `=== agent (HTTP, no git)`, `=== clone (git remote = the hosted
store)` and `=== store health`. The agent writes and recalls over HTTP, the clone syncs and sees
what the agent wrote, and the health line at the end is the same JSON as above, with the
scheduler counters moved. The script removes its containers when it finishes.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER YNM_NO_CLAUDE_CLI
```

To run this for real, see [Operate a hosted store](../how-to/operate-a-hosted-store.md).
