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
| `YNM_JWKS_URL`, `YNM_OAUTH_INTROSPECTION_URL` or `YNM_MCP_TOKEN` | How tokens are verified, exactly as for the server ([Authentication](operate-a-hosted-store.md#authentication)). One is required: a function is public, so without any the function refuses to start (`YNM_LAMBDA_ALLOW_OPEN=1` overrides that for local tests). A static `YNM_MCP_TOKEN` is a shared secret: everyone using it is recorded as `token:static`, so for a per-person audit trail use an identity provider |
| `YNM_REQUIRED_SCOPES` | Scopes every token must carry, as for the server |
| `YNM_TOKEN_BUDGET` | Cap on model input tokens per instance for dream runs, as for the server |
| Model keys | `TYPESAFE_API_KEY`, `OPENAI_API_KEY` and friends, if dream should use a model ([Configure the judge and writer](configure-judge-and-writer.md)) |
| `YNM_SSM_ENV_PATH` | A Parameter Store path, such as `/ynm/acme/env/`. At cold start every parameter under it named like an environment variable (`/ynm/acme/env/YNM_MCP_TOKEN`) becomes that variable, unless the function already sets it. Keep secrets (tokens, model keys) there as `SecureString` rather than in the function's environment; the function's role needs `ssm:GetParametersByPath` on the path. A parameter whose value is `unset` is skipped |

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
| `{ "ynm": "dream" }` | every 15 minutes | One consolidation run, the same run the server's `--dream-every` makes, under the same token budget. It judges only memories new or changed since the last run, so on a quiet store it calls no model |
| `{ "ynm": "compact" }` | daily | Compacts the store where the provider supports it (the `s3` provider merges a shard's small objects); a no-op that says so otherwise |

A failed dream run is logged and then fails the invocation, so Lambda's error metric and an alarm
on it catch it.
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

Lambda sends the function's log lines to CloudWatch Logs. With the Text log format each line
starts with the time, the invocation's request id and a level (`INFO` or `ERROR`).

### One line per request

Every request gets one line when its response is ready:

```text
[ynm-mcp lambda] request POST /mcp 200 143ms rpc=tools/call tool=memory_recall auth=static id=8f1c2d9e-4b7a-4e0f-9a51-3c6d2b1e7f40
```

Method, path, HTTP status and duration always come first, in that order. The fields after them
appear only when they apply:

| Field | Meaning |
|---|---|
| `rpc=` | The JSON-RPC method, such as `initialize`, `tools/list` or `tools/call`; several, comma-separated, for a batch |
| `tool=` | The tool a `tools/call` names |
| `auth=` | `static` (the shared token), `signed-in` (a person's token), `token` (a verified token that names no person), `none` (auth is off), `refused` (no valid token: a `401`), or `public` (`/health`, sign-in discovery and preflight requests, answered before the token check) |
| `client=` | The OAuth client id of a token from an identity provider |
| `cut=timeout`, `cut=gateway` | The response was cut off about a second before a deadline, with what it had so far: the function's timeout, or API Gateway's 30 seconds counted from when the request arrived. See below |
| `waited=` | How long the request waited between reaching API Gateway and the handler starting on it, mostly a cold start's init |
| `cold` | The first invocation this instance served (a request or a scheduled run), so it paid for opening the store and building the index |
| `id=` | The Lambda request id, the same one on every line of the invocation |

A line never holds a token, a header's value, the query string, or anything from the request or
response body beyond the method and tool name. Memory content and recall queries never appear.
A `5xx` response or a cut-off response is logged at `ERROR`; everything else at `INFO`.

A request that fails inside the function adds a line with the error before its request line,
under the same id. The client sees a `500`:

```text
[ynm-mcp lambda] request failed id=8f1c2d9e-…: <error message>
[ynm-mcp lambda] request POST /mcp 500 2210ms rpc=tools/call tool=memory_remember auth=static id=8f1c2d9e-…
```

Scheduled runs get one line each, with how they ended and how long they took. A failed run logs
its error first and then fails the invocation:

```text
[ynm-mcp lambda] scheduled dream ok 812ms id=…
[ynm-mcp lambda] scheduled dream failed 30ms id=…: dream: <error message>
```

The function also logs its auth mode at start and each compact run's summary.

### Timeouts and API Gateway errors

API Gateway gives up on a request 30 seconds after it arrived and answers `504` itself. Its clock
starts before the function's: a cold start's init counts towards the 30 seconds but not towards
the function's own timeout. So the function watches both deadlines. It stops reading a response
about a second before whichever comes first, the function's timeout or API Gateway's 30 seconds
from the request's arrival, and returns what it has with the status the handler set (usually
`200`). The request line then says `cut=timeout` or `cut=gateway`, and `waited=` shows how long
the request spent before the handler started. That happens when a tool call is still running near
a deadline, a client holds a stream open, or a slow cold start used up most of the time.

Some failures still never reach ynm's log as a request line: API Gateway answers `502` or `500`
itself when the function crashes or cannot start, and a cold start that alone outlasts the 30
seconds is a `504` before the handler runs. Lambda's own `Task timed out` and `Invoke Error`
lines show a function that ran out of time or crashed. To match a `5xx` count in API Gateway's
metrics with the log, look for those lines, `cut=` lines, and large `waited=` values.

### Find requests in CloudWatch

Filter patterns for the console's log search or `aws logs filter-log-events --filter-pattern`:

| To find | Filter pattern |
|---|---|
| Every request line | `"[ynm-mcp lambda] request "` |
| Errors of any kind | `?"request failed" ?"cut=" ?"scheduled dream failed" ?"Task timed out" ?"Invoke Error"` |
| `5xx` and cut-off answers from ynm (logged at `ERROR`) | `"[ynm-mcp lambda] request " "ERROR"` |
| One tool's calls | `"tool=memory_remember"` |
| One invocation | `"id=8f1c2d9e-4b7a-4e0f-9a51-3c6d2b1e7f40"` |

For slow requests, counts or percentiles, use Logs Insights:

```text
fields @timestamp, @message
| filter @message like "[ynm-mcp lambda] request "
| parse @message /request (?<method>\S+) (?<path>\S+) (?<status>\d+) (?<ms>\d+)ms/
| filter status >= 500 or ms >= 10000
| sort ms desc
```

### Audit events

With auth configured, each MCP request and each refused one also writes an audit event as one
JSON line on stdout, so the log group holds them too; set `YNM_AUDIT` to `{"sink":"s3"}` to keep
them under `audit/` in the store's bucket instead, with their own retention. See
[People and Audit](operate-a-hosted-store.md#people) in Operating a hosted store.

### Telemetry

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (and `OTEL_EXPORTER_OTLP_HEADERS` if your backend needs a key)
to send a span per request, tool call and store call to an OpenTelemetry collector. A request
carrying a `traceparent` header joins the caller's trace. Each invocation sends what it buffered
before it returns, within the time it has left and never more than 2 seconds, so a slow collector
cannot make a request late. See
[Send telemetry to an OpenTelemetry collector](send-telemetry.md).

On Lambda, use an OTLP endpoint. A function can also write to a ynr spool with `YNR_SPOOL`, but its
only local disk is `/tmp`, which goes when the instance does, and nothing beside the function
reads it, so what it wrote would be lost. Until ynr offers a relay a function can send to, the
endpoint is the way to get a function's telemetry out. The function does not look for a spool
again after it starts.

## Alarms

The Terraform in `infra/aws/lambda` raises two alarms, both mailed to `alarm_email`:

- **API 5xx rate.** More than 5% of requests answered `5xx` in 2 of 3 five-minute periods. A
  period with fewer than 10 requests does not count, so a burst of retries or one failure on an
  idle store does not page, but a sustained error rate does.
- **Function errors.** An invocation that threw or timed out (a failed scheduled run, a cold
  start that cannot start, a timeout) in 2 five-minute periods within two dream intervals (at
  least 30 minutes). One transient dream failure does not page; a dream that fails every run
  pages on its second failure.

The thresholds are variables, listed in
[`infra/aws/README.md`](../../infra/aws/README.md#alarms).
If you build the function some other way, alarm on the same metrics: API Gateway's `5xx` over
its `Count`, and Lambda's `Errors`.
