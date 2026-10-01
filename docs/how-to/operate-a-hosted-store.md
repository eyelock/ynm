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

`infra/docker/docker-compose.yml` is the reference topology: a store, an agent client with no
git, and a developer clone that syncs through `git://store/store.git` (`YNM_GIT_DAEMON=1`
serves the bare repo with receive-pack enabled; use SSH or a forge for anything beyond a demo).

## Authentication

Chosen from the environment, first match wins:

| Variables | Mode | Use |
|---|---|---|
| `YNM_JWKS_URL`, optional `YNM_JWT_ISSUER`, `YNM_JWT_AUDIENCE` | JWT verified against a JWKS (jose) | Production with an identity provider; scopes from `scope` or `scp` |
| `YNM_OAUTH_INTROSPECTION_URL`, `YNM_OAUTH_CLIENT_ID`, `YNM_OAUTH_CLIENT_SECRET` | RFC 7662 introspection, results cached 60 s | Opaque tokens from an authorisation server |
| `YNM_MCP_TOKEN` (comma-separated list) | Static bearer | Development and demos |
| none | Open | Local only; the server logs `auth: none` |

`YNM_REQUIRED_SCOPES=memory:read,memory:write` makes every request carry those scopes (403
otherwise). Failures answer RFC 6750 challenges (`WWW-Authenticate: Bearer ...`).

**Key rotation.** Static tokens: set `YNM_MCP_TOKEN=new,old`, roll clients to `new`, then drop
`old` and restart. JWT: rotation happens at the issuer; the JWKS is fetched on demand and cached
by jose, so new `kid`s work without a restart. Introspection: rotate the client secret at the
authorisation server and restart with the new value.

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

The dream worker shares the process. Its cost is bounded by `YNM_TOKEN_BUDGET` (input tokens
per process, default 2M) and the per-pass pair cap in `dream` config; the `/health` scheduler
block shows the last run's pass summary and any error.

## Local clones and the hosted store

Developers add the hosted repo as a remote (`ynm init` writes the distributed fetch refspec and a
pre-push hook), then `ynm sync` fetches, merges (`cat_sort_uniq`) and pushes distributed notes. Pushes
land on the same refs the server writes under its lock; a rejected push retries after a fresh
fetch. Personal memory never leaves the developer's own `~/.ynm/store.git`.
