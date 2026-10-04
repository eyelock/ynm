# ADR-009: Hosting topologies and bootstrap

Status: accepted (2026-09-29)
Satisfies: FR-20, FR-21, NFR-6, NFR-11, NFR-14

## Context

Requirement: "allow all different types of hosting". Git notes carry constraints (no default fetch,
no forge protection, multi-writer contention). mcp-toolkit `spec-update` already has stdio and
Streamable HTTP transports on SDK v2 with origin/host validation and bearer auth; ACME has OAuth
introspection and JWT verifiers.

## Decision

Four topologies, one codebase, selected by mounts in config. The hosted service is a first-class
topology, not a later addition, and that shaped the design from the start: the server is
stateless, the service layer never assumes a local checkout or a working tree, and every provider
works against a bare repo.

1. **Local in-repo**: stdio server launched by the client; mounts `personal` (`~/.ynm/store.git`)
   and `project` (this repo's shared refs). Sync via the repo's remote.
2. **Personal global**: same, without a project mount. Works outside any git repo.
3. **Dedicated shared repo**: a memory-only bare repo (on disk, GitHub, GitLab, Bitbucket, Gitea)
   mounted as `org`; stdio locally or HTTP. Proven by the Gitea container test (NFR-6).
4. **Hosted service**: the HTTP transport in front of a bare repo (or the sqlite provider). The
   server is the single writer, so no ref contention; clients never need git.

**One binary.** `ynm serve` starts the MCP server: stdio by default (what client adapters
register), `--http` for the hosted service. `ynm-mcp` remains as the server package's own bin.
This is what lets a single Homebrew formula cover the CLI, the stdio server and the hosted
service.

**Transports.** stdio through `serveStdio`; Streamable HTTP (protocol 2026-07-28 with the SDK's
legacy fallback) through `createMcpHandler` plus `toNodeHandler` with a fresh server per request,
host and origin validation in front, localhost CORS, and `/health` outside auth. The MCP server
opens the service once per process and relies on index freshness for writes from elsewhere.
Binding to `0.0.0.0` disables the Host header check (`--allow-host *`) because a container's own
hostname is unknown; a public listener sets `--allow-host <name>`.

**Auth.** Three verifiers behind the SDK's `OAuthTokenVerifier` seam: static tokens (dev), RFC
7662 introspection with a cache (copied in spirit from ACME), and JWT via JWKS with jose. The
transport uses `verifyBearerToken` and answers RFC 6750 challenges (401 `invalid_token`, 403
`insufficient_scope`); verifiers throw the SDK's `OAuthError` (anything else becomes a 500) and
every `AuthInfo` carries an expiry (the SDK rejects one without). Mode is chosen from the
environment: `YNM_JWKS_URL` > `YNM_OAUTH_INTROSPECTION_URL` > `YNM_MCP_TOKEN` > none;
`YNM_REQUIRED_SCOPES` enforces scopes.

**Scheduler.** The dream worker is a scheduler inside the hosted process (`--dream-every`,
`--sync-every`): runs never overlap, a failing run is recorded and the next tick retries, stats
are on `/health`. Hosted consolidation is also reachable through `memory_consolidate` over HTTP.

**Packaging.** A Docker image (alpine, `Dockerfile`; the entrypoint creates or adopts the bare
repo and optionally serves it over git:// with `YNM_GIT_DAEMON=1`) and a compose demo under
`infra/docker/` (`demo.sh`: a store, an agent with no git, a developer clone that syncs through
the container). The release workflow publishes the image to ghcr.io.

**`ynm init`** (project): detect repo and worktree; create a root commit if none; write
`.ynm/config.json` (anchor, mounts, index, redaction, dream thresholds); add
`remote.<r>.fetch +refs/notes/ynm/shared/*:refs/notes/ynm-remote/<r>/shared/*` and
`remote.<r>.push refs/notes/ynm/shared/*` (prepending `HEAD` to the push refspecs when none
exist, because an explicit push refspec otherwise replaces git's default and plain `git push`
would stop pushing the branch); install a `pre-push` hook that runs `ynm sync --quiet`; build the
index. Sync sets `YNM_SYNC_IN_PROGRESS=1` on its own git calls and the hook exits when it sees
it, otherwise the hook re-enters sync forever. `--personal` and `--bare <target>` create the root
commit in a fresh bare repo; the personal store's anchor is recomputed from its `main` root on
every open rather than cached. `ynm client install <name>` writes client config (ADR-013).

**`ynm doctor`**: refspecs present, hooks present, anchor reachable, shards parse, index fresh,
divergence per shard, personal refs absent from push refspecs, client status, node and git
versions.

**Config precedence** (copied from ACME): defaults → `~/.ynm/config.json` →
`<repo>/.ynm/config.json` → `<worktree>/.ynm/config.local.json` → env `YNM_*`.

`memory_sync` against a repo with no remote reports the missing remote in the result instead of
failing.

## Retrofit into an existing repository

Retrofit is the normal case; greenfield is the degenerate case where init creates the root commit.
`ynm init` in an existing repo changes no branch, tag, commit or tracked file. It adds refs under
`refs/notes/ynm/*`, local refspecs and hooks in `.git/` (never committed), and optionally
`.ynm/config.json`, the one file a team may commit to share mounts, anchor and redaction
settings. Teammates who have not run init see nothing until they do.

Cases handled:

- Multiple root commits: oldest by date, recorded in config (ADR-003).
- Shallow clones: work, because the anchor SHA is only a tree path (ADR-003).
- Existing users of `refs/notes/commits` or other notes: untouched, separate namespace.
- Existing ACME data: not imported. ACME never left one laptop, so there is nothing to migrate;
  `ynm import` takes ynm's own JSONL only (decided 2026-09-29).
- Monorepos: several projects share the root commit and are separated by namespace (ADR-001).
- Forks and mirrors: notes do not follow unless the fetch refspec is configured there; the doctor
  checks.
- Many writers on one shard: push retries rise; that is the signal to move that store to the
  hosted single-writer topology, not a blocker for starting local.

## Alternatives considered

- Hosted-only (like Mem0 cloud). Rejected: local-first is the point of git notes.
- Local-only. Rejected: production agents without a git checkout need the HTTP shape.

## Consequences

- Operations are documented in `docs/how-to/operate-a-hosted-store.md`: auth modes and key rotation, backups with
  `git bundle --all`, one writer per store (scale by store, not by replicas), and how local
  clones sync with a hosted store (the hosted repo is simply their remote).
- A client that talks to the hosted store and also has a local project mount gets two mounts;
  recall spans both and labels the origin.
- Release packaging (tarball, Homebrew formula, image) is described in `docs/how-to/cut-a-release.md`.

## Open questions

- None.

## History

- 2026-09-28: hosted service made a first-class v1 topology.
- 2026-09-29 (M1): pre-push hook recursion guard; `HEAD` prepended to push refspecs; personal
  anchor recomputed on open.
- 2026-09-29 (M3): both transports shipped; `memory_sync` without a remote reports it.
- 2026-09-29 (M5): auth verifiers, in-process scheduler, `ynm serve`, Docker image and compose
  demo, operations doc, Gitea test.
- 2026-09-29 (M6): release workflow publishes the tarball, the Homebrew formula and the image.
- 2026-09-30: packaging (standalone binaries, the slim bundle, two formulae) moved to
  [ADR-015](015-distribution.md); the image is unchanged.
- 2026-09-30: `ynm init` also configures every detected agent client, which can edit client
  files in the work tree; `--no-clients` restores the memory-only retrofit. See
  [ADR-016](016-agent-guidance-delivery.md).
- 2026-10-01: the hosted topology also runs as an AWS Lambda function (`packages/mcp/src/lambda.ts`,
  the same front door and handler, a fresh server per request; `YNM_PUBLIC_URL` names the public
  host; EventBridge Scheduler invokes dream and compaction). The single-writer rule is about git
  refs: a store with no shared ref, such as `s3`, may take writes from many instances.
- 2026-10-04: the Lambda entry and `ynm serve --http` log one line per request (method, path,
  status, duration, JSON-RPC method and tool, auth kind, and on Lambda the request id and a mark
  for a response cut off near the timeout), and one line per scheduled run; never tokens, queries
  or bodies (`packages/mcp/src/transport/request-log.ts`). The Lambda Terraform alarms on the API's
  5xx rate over its request count, with a request floor and 2 of 3 periods, and on function errors
  in 2 periods over two dream intervals, instead of on any single burst.
- 2026-10-04: the Lambda handler cuts a response off before API Gateway's 30 s, counted from the request's arrival (`timeEpoch`), as well as before the function's own timeout; a cold start's init counts towards the first but not the second.
