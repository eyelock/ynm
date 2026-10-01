# Host ynm on AWS Lambda

Goal: run a hosted store as an AWS Lambda function, so it costs close to nothing while nobody
is using it. The function serves the same MCP endpoint as `ynm serve --http`: the same tools,
the same token checks, `/health` outside auth, a fresh MCP server for every request. Clients
connect to it exactly as they connect to a server ([Connect a client over HTTP](connect-over-http.md)).
To choose between a function and a long-running server, see
[Operate a hosted store](operate-a-hosted-store.md#server-or-lambda).

## The store

A function's local disk (`/tmp`) belongs to one instance and is lost when AWS recycles it, and
several instances can run at once. The store must therefore live somewhere else and accept
writes from more than one instance. Use the `s3` provider: one object per write, no lock, any
number of writers. Its setup is in [Choose the s3 provider](choose-the-s3-provider.md). A
git-notes store does not fit: it needs `git` and a local repository, and it expects one writer.

Only the index lives in `/tmp`. It is derived data, rebuilt from the store when an instance
starts.

## Get the package

Each release attaches `ynm_<version>_lambda.zip`. It holds one file, `index.mjs`, which exports
`handler`. From a checkout, `make lambda` builds the same package as `dist/lambda.zip` and
smoke-tests it.

## Create the function

| Setting | Value |
|---|---|
| Runtime | Node.js 24 (`nodejs24.x`) |
| Handler | `index.handler` |
| Architecture | `arm64` (cheaper); `x86_64` works with the same zip |
| Memory | 1024 MB. Rebuilding the index on a cold start is CPU-bound, and Lambda gives CPU in proportion to memory |
| Timeout | 30 s for requests. Raise it if dream runs with a model-backed judge take longer: one timeout covers both |
| Ephemeral storage | The default 512 MB, unless the index of your store is bigger |

The execution role needs read and write access to the store, for the `s3` provider its bucket
and prefix, and the usual CloudWatch Logs permissions.

## Configure it

The function reads its configuration from environment variables alone. There is no config file.

| Variable | Value |
|---|---|
| `YNM_PUBLIC_URL` | Required. The URL clients use, such as `https://memory.example.com/mcp`. The function is reached through AWS's own host name (and often through a CDN), so it cannot learn this from the request. The function refuses to start without it |
| `YNM_MOUNTS` | The store, as a JSON array of mounts, for example `[{"id":"team","level":"distributed","provider":"s3","bucket":"acme-memory","prefix":"team"}]` |
| `YNM_JWKS_URL`, `YNM_OAUTH_INTROSPECTION_URL` or `YNM_MCP_TOKEN` | How tokens are verified, exactly as for the server ([Authentication](operate-a-hosted-store.md#authentication)) |
| `YNM_REQUIRED_SCOPES` | Scopes every token must carry, as for the server |
| `YNM_TOKEN_BUDGET` | Cap on model input tokens per instance for dream runs, as for the server |
| Model keys | `TYPESAFE_API_KEY`, `OPENAI_API_KEY` and friends, if dream should use a model ([Configure the judge and writer](configure-judge-and-writer.md)) |

`YNM_HOME` defaults to `/tmp/ynm` on Lambda. The personal mount is never opened: a hosted store
is distributed memory only. `YNM_NO_CLAUDE_CLI` defaults to `1`, because the function has no
`claude` command. Every variable is listed in the
[configuration reference](../reference/configuration.md#environment-variables).

## Expose it

Create a **Function URL** with auth type `NONE` and invoke mode `BUFFERED`. Auth `NONE` is
deliberate: ynm verifies every token itself and answers a missing or bad one with a `401` and a
`WWW-Authenticate` challenge, as the server does. IAM auth would demand AWS-signed requests,
which MCP clients do not send.

To serve it on your own domain, put CloudFront in front of the Function URL:

- Forward the `Authorization` header to the origin. CloudFront drops it by default, and every
  request would then be refused. The managed origin request policy
  `AllViewerExceptHostHeader` forwards it and every other viewer header except `Host`.
- Do not forward `Host`: a Function URL accepts only its own host name.
- Disable caching (`CachingDisabled`) and allow `GET`, `POST`, `DELETE` and `OPTIONS`.
- Set `YNM_PUBLIC_URL` to the CloudFront address clients use.

## Schedule the background work

The server runs consolidation on a timer inside its process; a function has no process between
requests. Use EventBridge Scheduler instead, with the function as the target and a JSON input:

| Input | Suggested rate | What it does |
|---|---|---|
| `{ "ynm": "health" }` | every 5 minutes | Keeps an instance warm and its index built, so most requests skip the cold start |
| `{ "ynm": "dream" }` | every 15 minutes | One consolidation run, the same run the server's `--dream-every` makes, under the same token budget |
| `{ "ynm": "compact" }` | daily | Compacts the store where the provider supports it (the `s3` provider merges a shard's small objects); a no-op that says so otherwise |

A failed dream run fails the invocation, so Lambda's error metric and an alarm on it catch it.
There is no sync schedule: an `s3` store has nothing to sync.

## Cold starts

The first request to a new instance opens the store and rebuilds the index in `/tmp`; its time
grows with the size of the store. Later requests to that instance reuse both. Instances do not
share an index: each one sees writes made through the others because the index checks the store
for changes before it answers. The keep-warm schedule keeps one instance ready; a burst of
traffic that starts more instances pays a cold start on each new one.

## Check it

```bash
curl https://memory.example.com/health
```

answers without a token:

```json
{"status":"ok","name":"ynm","auth":"jwt","runtime":"lambda","scheduler":{"dreamRuns":0,"syncRuns":0,"lastDreamAt":null,"lastSyncAt":null,"lastError":null,"lastDream":null}}
```

The scheduler block counts the dream runs of the instance that answered, not of the function as
a whole. Then connect a client with `ynm client install <client> --http
https://memory.example.com/mcp --token ...`.

## Logs

The function writes its log lines to stderr, and Lambda sends them to CloudWatch Logs: the auth
mode at start, each dream and compact run, and any request that failed inside the function
(which the client sees as a `500`). Requests refused by the token check are not errors and are
not logged.
