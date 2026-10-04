# Operating a hosted ynm store

A hosted store is one process per store: the Streamable HTTP MCP server in front
of a bare git repository (or a SQLite file), the single writer for that store, with the dream
worker and sync on timers. Agents connect over HTTP with a bearer token; they never need git.
Developers who do have git use the hosted repo as an ordinary remote.

## Server or Lambda

The same MCP endpoint runs in two shapes:

| | Server (container or `ynm serve --http`) | AWS Lambda function |
|---|---|---|
| Runs | all the time | per request; idle costs close to nothing |
| Store | git-notes or sqlite on its own disk, or any store it can mount | one that does not live on the function's disk: the `s3` provider |
| Writers | one process, the single writer | many instances at once, which the store must allow |
| Dream and sync | timers in the process (`--dream-every`, `--sync-every`) | EventBridge Scheduler invokes the function; no sync |
| Index | built once, kept on disk | rebuilt in `/tmp` on each cold start |
| Git clients | can use the store's repository as a remote | none: agents connect over HTTP only |

Pick the server for a git-notes store that developers also sync with, or for steady traffic.
Pick Lambda for an agents-only store used in bursts. A store on the `s3` provider can be mounted
by either, so moving between them is a redeploy. The rest of this page is about the server;
[Host ynm on AWS Lambda](host-on-aws-lambda.md) covers the function.

## Run it

```sh
# container (recommended)
docker run -d --name ynm -p 3000:3000 -v ynm-data:/data \
  -e YNM_MCP_TOKEN=change-me -e YNM_DREAM_EVERY=15m ghcr.io/eyelock/ynm

# or from a checkout, one binary
ynm serve --http --host 0.0.0.0 --port 3000 --no-personal --cwd /srv/memory.git \
  --dream-every 15m --sync-every 5m
```

The entrypoint creates the bare repo on first start (`ynm init --bare` then `ynm init` inside
it) under `/data/store.git`. `GET /health` reports auth mode and scheduler stats and is outside
auth. Bind to `0.0.0.0` only in containers or behind a proxy: the Host header check is then
disabled (`--allow-host *`); set `--allow-host memory.example.com` on a public listener.

On AWS, [`infra/aws`](../../infra/aws/README.md) runs one store per client, either as a Lambda on
an s3 store (close to free while idle) or as this container on a small server with the store on
its own volume, with sign-in through an identity provider such as an Auth0 tenant
([`infra/auth0`](../../infra/auth0/README.md)).

`infra/docker/docker-compose.yml` is the reference topology: a store, an agent client with no
git, and a developer clone that syncs through `git://store/store.git` (`YNM_GIT_DAEMON=1`
serves the bare repo with receive-pack enabled; use SSH or a forge for anything beyond a demo).

## Authentication

Chosen from the environment, first match wins:

| Variables | Mode | Use |
|---|---|---|
| `YNM_JWKS_URL`, optional `YNM_JWT_ISSUER`, `YNM_JWT_AUDIENCE` | JWT verified against a JWKS (jose) | Production with an identity provider; scopes from `scope` or `scp` |
| `YNM_OAUTH_INTROSPECTION_URL`, `YNM_OAUTH_CLIENT_ID`, `YNM_OAUTH_CLIENT_SECRET` | RFC 7662 introspection, results cached 60 s | Opaque tokens from an authorisation server |
| `YNM_MCP_TOKEN` (comma-separated list) | Static bearer | Development and demos; everyone holding it is one shared identity, `token:static` |
| none | Open | Local only; the server logs `auth: none` |

**A static token is a shared secret.** It says that a caller holds the token, not who they are,
so everyone using it gets the same identity: what they write is recorded as `token:static`, and the
audit log shows client `static` with no person. There is no per-person audit trail. A static token
lists several values only for rotation; they are the same identity. For per-person identity, use
an identity provider (JWT or introspection mode); give workers and CI jobs their own machine tokens
from the provider's client credentials grant, so each one is a person of its own in the records and
the audit log.

`YNM_REQUIRED_SCOPES=memory:read,memory:write` makes every request carry those scopes (403
otherwise). Failures answer RFC 6750 challenges (`WWW-Authenticate: Bearer ...`).

**Signing in from a client.** With JWT auth and `YNM_JWT_ISSUER` set, the server tells clients
where to sign in. It serves `/.well-known/oauth-protected-resource` (RFC 9728), naming the issuer
as the authorization server, and its 401 challenge points at that document. A client with MCP
sign-in support, such as Claude Code, then finds the identity provider, opens the sign-in page in
the browser and sends the token it gets back, so nobody pastes a token. The document names:

| Field | From |
|---|---|
| `authorization_servers` | `YNM_JWT_ISSUER` |
| `resource`, the URL tokens must be issued for | `YNM_PUBLIC_URL`, else `YNM_JWT_AUDIENCE` when it is a URL, else this server's `/mcp` URL |
| `scopes_supported` | `YNM_REQUIRED_SCOPES`, when set |

Set the audience your identity provider puts in tokens to the same URL as the resource. The
identity provider must let the client obtain a client ID: by dynamic client registration, or with
a client registered in advance and given to the client (`claude mcp add --client-id ...`).

**Key rotation.** Static tokens: set `YNM_MCP_TOKEN=new,old`, roll clients to `new`, then drop
`old` and restart. JWT: rotation happens at the issuer; the JWKS is fetched on demand and cached
by jose, so new `kid`s work without a restart. Introspection: rotate the client secret at the
authorisation server and restart with the new value.

## People

With JWT or introspection auth, every request whose token carries a subject (`sub`) comes from a
person, and what they write is theirs.

- **Who.** Each sign-in resolves to a ynm person id such as `pq3x7k2mabcdwxyz`, derived from the
  identity provider's issuer and subject. A memory's `provenance.actor` is `user:<person id>`,
  and `provenance.client` is the client they wrote through. No email or other claim is read or
  stored. A static token (`YNM_MCP_TOKEN`) vouches for no one, so its writes are recorded as
  `token:static`, the same for everyone who holds it, never as the server's own user, and a
  memory written with it that names no namespace goes to `common`. An identity provider's token
  that carries no subject but names the client it was issued to (a JWT's `azp` or `client_id`, an
  introspection response's `client_id`) identifies no person either: its writes are recorded as
  `client:<client id>`, and one that names no namespace also goes to `common`. Only a token with
  neither a subject nor a client is recorded as the server's own actor. Writes the server makes
  itself, such as a scheduled dream run, keep the server's own actor.
- **Sharing is explicit.** A hosted store has no personal level, so a new memory is stored only
  when the call says `level: distributed`; one that names no level is refused with an explanation,
  and the server's instructions tell agents to ask the person before sharing. Editing, retiring
  and annotating memories already on the store work as before.
- **Where.** A shared memory that names no namespace goes to the writer's own `user/<person id>`.
  Name one, such as `common`, to file it with the team.
- **Nicknames.** A person sets how they appear with the `memory_people` tool (ask the agent to
  "set my ynm nickname to Sam"), or checks who they are with `memory_people` `whoami`. A caller
  with no person, using a static token or a token with no subject, gets an explanation instead. `ynm list`,
  `ynm review list`, recall results and the wiki then show the nickname, else the person id. A
  nickname is visible to everyone who can read the store, so make it a nickname, not a legal name.
- **Operators.** `ynm people list` shows everyone with a nickname or a linked login;
  `ynm people clear <person id>` removes a nickname and `ynm people nickname <person id>
  --nickname ...` sets one. They need write access to the store.
- **Changing identity provider.** Signing in through a new provider gives a new login, which on its
  own would be a new person. Before moving, link it: have the person sign in once through the new
  provider and run `memory_people` `whoami` to see the login's issuer and subject, then
  `ynm people link <their existing person id> --issuer <issuer> --subject <subject>`. From then
  on that login writes as the same person, into the same namespace.

The nicknames and linked logins live in one small document beside the memories (`documents/people`
in the store), not in any memory, so changing one never rewrites history.

## Logs

The server writes one line per request to stderr when the response ends:

```text
[ynm-mcp] request POST /mcp 200 143ms rpc=tools/call tool=memory_recall auth=signed-in client=claude-code
```

Method, path, HTTP status and duration, then the JSON-RPC method and tool, how the caller
authenticated (`static`, `signed-in`, `token`, `none`, `refused`, or `public` for health and
discovery), and the OAuth client id of an identity provider's token. A response the client
abandoned before it ended is marked `cut=client`. A line never holds a token, a header's value,
the query string, or anything from the request or response body beyond the method and tool name.
The fields are the same as a Lambda function's request line, described in
[Host ynm on AWS Lambda](host-on-aws-lambda.md#one-line-per-request).

## Audit

Every request that reaches the MCP handler, and every refused one, produces one audit event:
when, the person id and client (a static token has no person and client `static`; a token with no
subject has no person and the client it names), method, path,
HTTP status, outcome (`ok`, `refused` or `error`),
a refusal's error code, the tools called with the memory ids they touched, the input size and
result count, and how long it took. Events never hold tool inputs, queries or memory content.
Health checks and sign-in discovery are not audited.

`YNM_AUDIT` picks where events go ([configuration reference](../reference/configuration.md)):
stdout (one JSON line per event, the default when the server checks tokens), a JSONL file rotated
at 10 MiB, or S3 (one object per event at `audit/<store prefix>/<yyyy>/<mm>/<dd>/<id>.json`,
outside the store's own prefix, so a retention rule on `audit/` can never expire memory). A sink
that fails is reported on stderr and never fails the request.

## Backups

The store is a git repository (or, with the sqlite provider, one file). Bundle it or mirror it;
the index is derived data. The commands, for both providers, are in
[Back up and restore](back-up-and-restore.md).

## Scaling

One writer per store is the rule for a git-notes or sqlite store. Scale by store (one container per team or namespace root),
not by replicas of one store. Reads are cheap: the index is SQLite FTS on local disk, p95 recall
under 200 ms at 100k memories on the reference machine. If a store outgrows a single
writer, split by namespace or move that store to the sqlite provider (`provider: sqlite` in the
store's `config.json`) which drops the git write path entirely. A store on the s3 provider has
no single writer at all: several servers can mount the same bucket prefix and write at once
([Choose the S3 provider](choose-the-s3-provider.md)).

The dream worker shares the process. Each run judges only memories new or changed since the last
one, so a quiet store costs no model calls however often it dreams. A busy store's cost is
bounded by `YNM_TOKEN_BUDGET` (input tokens per process, default 2M) and the per-pass pair cap in
`dream` config; the `/health` scheduler block shows the last run's pass summary and any error,
and the log line for each run says how many memories were fresh.

## Local clones and the hosted store

Developers add the hosted repo as a remote (`ynm init` writes the distributed fetch refspec and a
pre-push hook), then `ynm sync` fetches, merges (`cat_sort_uniq`) and pushes distributed notes. Pushes
land on the same refs the server writes under its lock; a rejected push retries after a fresh
fetch. Personal memory never leaves the developer's own `~/.ynm/store.git`.
