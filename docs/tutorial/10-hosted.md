# Hosted Service

Run ynm as a server: one process in front of one bare repository, speaking MCP over HTTP. Agents
connect with nothing but a URL and a token; they never need git.

The tutorial has two parts. In part 1 the server takes one static token: you start it, check its
health, are refused without the token, make MCP calls with curl, and see the result land in the
repository. In part 2 people sign in through an identity provider instead, the way a shared
server is run: each person gets their own token, a client finds where to sign in by itself, and
the server refuses a token that lacks the access it needs. Last, your own ynm mounts the server
as its shared store, so personal memory stays on your machine beside it.

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

## Part 1: a static token

A static token is the quickest way to try the server, and fine for a demo. It is a shared secret:
everyone who has the token is the same caller, recorded as `token:static`, so the server can't tell
them apart. Part 2 gives each person an identity of their own.

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

Expected: one line of JSON whose `result` names the server (`"serverInfo":{"name":"ynm","version":"<version>", ...}`),
its capabilities (tools, resources and prompts) and an `instructions` string. It tells an agent
that ynm is the user's memory, to use `memory_remember` rather than any built-in memory when
asked to remember something, and to read `memory_recall` or `memory_context` before answering
about the user or the project. Its last line begins
`- Level: distributed only: everything stored on this server is shared with everyone who uses it`,
because this server mounts no personal store, and goes on to tell the agent to ask before
sharing. A client connected with nothing but the URL gets this text and the tool descriptions,
and nothing else.

Now write a memory the way an agent would by default, naming no `level`:

```bash
curl -s -X POST http://localhost:3999/mcp -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_remember","arguments":{"type":"semantic","content":"The hosted store answers on port 3999."}}}' | grep '^data:' | cut -c7-
```

Expected: a result with `"isError":true` and nothing stored:

```text
{"result":{"content":[{"type":"text","text":"nothing stored: this store has no personal level, so a memory stored here is shared with everyone who uses it. To share it, ask the user first, then set level to distributed. To keep it private, store it in a local ynm instead."}],"isError":true},"jsonrpc":"2.0","id":2}
```

Memory is personal by default, and this server has nowhere personal to put it. Sharing is a
choice, so the call has to make it: `"level":"distributed"`. Write it that way, then read it back:

```bash
curl -s -X POST http://localhost:3999/mcp -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_remember","arguments":{"type":"semantic","level":"distributed","content":"The hosted store answers on port 3999."}}}' | grep '^data:' | cut -c7-
curl -s -X POST http://localhost:3999/mcp -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_recall","arguments":{"text":"hosted store"}}}' | grep '^data:' | cut -c7-
```

Expected: two lines of JSON. The first is the result of `memory_remember`: its
`structuredContent` holds a new `memoryId`, `"mount":"project"` and a `revision` sha. The second
is `memory_recall`, whose `structuredContent.data` is an array with one hit, the memory you just
wrote, with `"level":"distributed"` and `"namespace":"common"`: a shared token vouches for no one,
so there is no person to file it under, and the hit names no author. Any MCP client library, such as
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

Who does the record say wrote it? The raw record keeps the writer in `provenance.actor`:

```bash
ynm export --level distributed --cwd /tmp/ynm-tutorial/store.git | grep -o '"actor":"[^"]*"'
```

Expected:

```text
"actor":"token:static"
```

Not you, and not the server's own user (`tutorial` here): the static token. Everyone who writes
with this token is recorded the same way, so there is no per-person audit trail. For that, the
server needs an identity provider, as in part 2.

## Stop the server

```bash
kill $(cat /tmp/ynm-tutorial/serve.pid)
sleep 1
curl -s -m 2 http://localhost:3999/health || echo "server stopped"
```

Expected: `server stopped`.

## Part 2: sign in with an identity provider

A shared server should know who is calling. Here the server verifies tokens issued by an identity
provider, and tells clients where to get one. The repository ships a local identity provider for
this, Keycloak, with two people already in it: `alice` (password `alice`) and `bob` (password
`bob`). It needs Docker and a checkout of the repository. To run this part, set
`DOCKER_HOST_AVAILABLE=1` in your shell and point `YNM_REPO` at the checkout, for example with
`export YNM_REPO=$HOME/src/ynm`, using the path of your own checkout. The steps run the
repository's `make` targets from there while your shell stays in the sandbox.

## Start the identity provider

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
make -C "$YNM_REPO" keycloak
make -C "$YNM_REPO" keycloak-check
```

Expected: `keycloak ready: http://localhost:8180/realms/ynm`, then a list of `ok` lines and
finally `keycloak gives ynm everything sign-in needs`. The check proves the provider publishes
its signing keys, lets a client register itself, issues tokens for `http://localhost:3000/mcp`
naming the person who signed in, and gives bob read access without write access when that is all
he asks for. The first start downloads the Keycloak image and can take a minute.

## Start the server with sign-in

Three settings point the server at the provider: where its signing keys are, who issues the
tokens, and the address tokens must be issued for. `YNM_REQUIRED_SCOPES` makes every request
need both read and write access:

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
YNM_JWKS_URL=http://localhost:8180/realms/ynm/protocol/openid-connect/certs \
YNM_JWT_ISSUER=http://localhost:8180/realms/ynm \
YNM_JWT_AUDIENCE=http://localhost:3000/mcp \
YNM_REQUIRED_SCOPES=memory:read,memory:write \
ynm serve --http --port 3000 --no-personal --cwd /tmp/ynm-tutorial/store.git > /tmp/ynm-tutorial/serve.log 2>&1 &
echo $! > /tmp/ynm-tutorial/serve.pid
until curl -sf http://localhost:3000/health > /dev/null; do sleep 0.5; done
curl -s http://localhost:3000/health
```

Expected: the health line now names the mode `jwt`:

```text
{"status":"ok","name":"ynm","auth":"jwt","scheduler":{"dreamRuns":0,"syncRuns":0,"lastDreamAt":null,"lastSyncAt":null,"lastError":null,"lastDream":null}}
```

## Where to sign in

Ask without a token, then read the document the refusal points to:

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
curl -s -i -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -d '{}' | grep -i -E '^HTTP|^www-authenticate'
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
```

Expected: a `401`, and a challenge that names the access needed and where to read about signing in:

```text
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", scope="memory:read memory:write", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
{"resource":"http://localhost:3000/mcp","authorization_servers":["http://localhost:8180/realms/ynm"],"scopes_supported":["memory:read","memory:write"],"bearer_methods_supported":["header"]}
```

The last line is that document: tokens must be issued for `http://localhost:3000/mcp`, by the
identity provider at `http://localhost:8180/realms/ynm`, with read and write access. That is
everything a client needs to sign a person in by itself.

## Write as alice

A client signs a person in through the browser. A script can ask the provider for a token
directly, which `make keycloak-token` does for alice:

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
ALICE=$(make -s -C "$YNM_REPO" keycloak-token U=alice)
curl -s -X POST http://localhost:3000/mcp -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_remember","arguments":{"type":"semantic","level":"distributed","content":"Sign-in to the hosted store goes through Keycloak."}}}' | grep '^data:' | cut -c7-
curl -s -X POST http://localhost:3000/mcp -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"memory_people","arguments":{"action":"nickname","nickname":"alice"}}}' | grep '^data:' | cut -c7-
ynm list --level distributed --cwd /tmp/ynm-tutorial/store.git
```

Expected: the `memory_remember` result, with a new `memoryId`, `"mount":"project"` and a
`revision` sha; the `memory_people` result, `{"person":"<person id>","nickname":"alice"}`; then
both memories in the store, the one from part 1 and alice's:

```text
<id>  semantic   distributed user/<person id>     Sign-in to the hosted store goes through Keycloak.  (alice)
<id>  semantic   distributed common                   The hosted store answers on port 3999.
```

Alice signed in, so her memory is hers: written as `user:<person id>`, a ynm id derived from her
sign-in, and filed in her own namespace because she named none. The nickname she set is how the
store shows her. The server's log holds one audit line per request, with her person id, the
client and the tools called, and none of the content.

## Bob can read but not write

Bob asks only for read access. This server needs both on every request, so it refuses him:

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
BOB=$(make -s -C "$YNM_REPO" keycloak-token U=bob S=memory:read)
curl -s -i -X POST http://localhost:3000/mcp -H "Authorization: Bearer $BOB" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"memory_recall","arguments":{"text":"sign-in"}}}' | grep -i -E '^HTTP|^www-authenticate'
```

Expected: a `403`, not a `401`. Bob is who he says he is, but lacks the access:

```text
HTTP/1.1 403 Forbidden
www-authenticate: Bearer error="insufficient_scope", error_description="Insufficient scope", scope="memory:read memory:write", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
```

## Sign in from Claude Code

This step needs a person at a browser, so it is not run automatically. With the server still
running, add it to Claude Code with nothing but its URL, from a folder of your choice:

<!-- tutorial: skip unless YNM_TUTORIAL_BROWSER -->

```bash
claude mcp add --transport http --scope local ynm-signin http://localhost:3000/mcp
claude
```

Expected: Claude Code starts and says one MCP server needs authentication. Run `/mcp`, pick
`ynm-signin` and choose Authenticate. A Keycloak login page opens in the browser; sign in as
`alice` / `alice`. The browser says authentication succeeded, and back in Claude Code `/mcp`
shows `ynm-signin` connected, with the `memory_*` tools. Ask Claude what it remembers about
sign-in: it calls `memory_recall` and finds alice's memory. To remove the server afterwards:
`claude mcp remove ynm-signin -s local`.

## Mount it from your own ynm

An agent connected to the server directly sees only the shared store. Your own ynm can mount the
server instead, as its distributed store: the agent then talks to one ynm, your personal memory
stays on your machine, and the server is reached for you, signed in as you. Add the mount to the
sandbox's config:

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
mkdir -p /tmp/ynm-tutorial/home
cat > /tmp/ynm-tutorial/home/config.json <<'EOF'
{ "mounts": [ { "id": "team", "level": "distributed", "provider": "mcp", "url": "http://localhost:3000/mcp" } ] }
EOF
ynm status
ynm recall --text "sign-in"
```

Expected: the status lists your personal store and the `team` mount, which says why it could not
be read; recall answers from personal memory alone, which is empty, and says what it left out:

```text
ynm <version>
config: /tmp/ynm-tutorial/home/config.json
  personal   personal     git-notes  0 shard(s)  index fresh (0)  /tmp/ynm-tutorial/home/store.git
  team       distributed  mcp        http://localhost:3000/mcp  (not signed in: run `ynm login team`)
no matches
shared memory left out: team: not signed in: run `ynm login team`
```

Being signed out, or offline, never stops ynm: reads go on without the shared store and say so.

## Sign in to the mount

Signing in needs a person at a browser, so this step is not run automatically:

<!-- tutorial: skip unless YNM_TUTORIAL_BROWSER -->

```bash
ynm login team
ynm remember --type semantic --content "I check sign-in changes against a fresh browser profile."
ynm remember --type semantic --level distributed --content "The hosted store's sign-in is checked before every release."
ynm recall --text "sign-in"
ynm list --level distributed --cwd /tmp/ynm-tutorial/store.git
ynm context
```

Expected: `ynm login` opens a Keycloak login page; sign in as `alice` / `alice`, and it prints
`signed in to team (http://localhost:3000/mcp)`. The first memory names no level, so it stays
personal: `remembered <id> in personal`. The second asks to share: `remembered <id> in team`.
Recall finds three memories in one list, your personal one and the two on the server, each
labelled with where it lives:

```text
0.016  <id>  semantic   personal  I check sign-in changes against a fresh browser profile.
0.016  <id>  semantic   team      Sign-in to the hosted store goes through Keycloak.
0.016  <id>  semantic   team      The hosted store's sign-in is checked before every release.
```

The listing of the server's store shows only the shared memory, written by alice, beside her
earlier one; the personal memory never left your machine. The context block has your memory first
and the shared store's after it:

```text
## Memory
- (semantic) I check sign-in changes against a fresh browser profile.

## Shared memory (team)
- (semantic) The hosted store's sign-in is checked before every release.
- (semantic) Sign-in to the hosted store goes through Keycloak.
```

`ynm doctor` shows the mount as signed in. The sign-in is kept in `auth/team.json` under the ynm
home (here the sandbox's), refreshes on its own, and `ynm logout team` forgets it.

## Stop the server and the identity provider

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
kill $(cat /tmp/ynm-tutorial/serve.pid)
make -C "$YNM_REPO" keycloak-down
```

Expected: the server stops, and Docker removes the Keycloak container and its data, so the next
`make keycloak` starts from a clean realm.

## The Docker demo

The repository ships a full demonstration in containers: a store, an agent client that speaks HTTP
with no git, and a developer clone that syncs through the store. It needs Docker and a
checkout of the repository, and it takes a few minutes to build. It runs with
`DOCKER_HOST_AVAILABLE` and `YNM_REPO` set as for part 2.

<!-- tutorial: skip unless DOCKER_HOST_AVAILABLE -->

```bash
"$YNM_REPO"/infra/docker/demo.sh
```

Expected: three headed sections, `=== agent (HTTP, no git)`, `=== clone (git remote = the hosted
store)` and `=== store health`. The agent writes and recalls over HTTP, the clone syncs and sees
what the agent wrote, and the health line at the end is the same JSON as above, with the
scheduler counters moved. The script removes its containers when it finishes.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER YNM_NO_CLAUDE_CLI YNM_REPO
```

To run this for real, see [Operate a hosted store](../how-to/operate-a-hosted-store.md), and
[Signing in from a client](../how-to/operate-a-hosted-store.md#authentication) for the settings
part 2 used.
