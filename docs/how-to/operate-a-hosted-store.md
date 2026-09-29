# Operating a hosted ynm store

The hosted topology (ADR-009) is one process per store: the Streamable HTTP MCP server in front
of a bare git repository (or a SQLite file), the single writer for that store, with the dream
worker and sync on timers. Agents connect over HTTP with a bearer token; they never need git.
Developers who do have git use the hosted repo as an ordinary remote.

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

The store is a git repository; everything lives under `refs/notes/ynm/`.

```sh
git -C /data/store.git bundle create /backups/ynm-$(date +%F).bundle --all
git clone --mirror /backups/ynm-2026-09-29.bundle restored.git   # restore
```

A mirror on a forge (`git push --mirror`) is a continuous backup. With the sqlite provider,
back up the file after `PRAGMA wal_checkpoint(TRUNCATE)` or copy `store.sqlite` plus `-wal`.
The index under `YNM_HOME` is derived data; delete it and the next request rebuilds it.

## Scaling

One writer per store is the rule. Scale by store (one container per team or namespace root),
not by replicas of one store. Reads are cheap: the index is SQLite FTS on local disk, p95 recall
under 200 ms at 100k memories on the reference machine (ADR-014). If a store outgrows a single
writer, split by namespace or move that store to the sqlite provider (`provider: sqlite` in the
store's `config.json`) which drops the git write path entirely.

The dream worker shares the process. Its cost is bounded by `YNM_TOKEN_BUDGET` (input tokens
per process, default 2M) and the per-pass pair cap in `dream` config; the `/health` scheduler
block shows the last run's pass summary and any error.

## Local clones and the hosted store

Developers add the hosted repo as a remote (`ynm init` writes the shared refspecs and a
pre-push hook), then `ynm sync` fetches, merges (`cat_sort_uniq`) and pushes shared notes. Pushes
land on the same refs the server writes under its lock; a rejected push retries after a fresh
fetch. Personal memory never leaves the developer's own `~/.ynm/store.git`.
