# ADR-009: Hosting topologies and bootstrap

Status: draft
Satisfies: FR-20, FR-21, NFR-6, NFR-11, NFR-14

## Context

Requirement: "allow all different types of hosting". Git notes carry constraints (no default fetch,
no forge protection, multi-writer contention). mcp-toolkit `spec-update` already has stdio and
Streamable HTTP transports on SDK v2 with origin/host validation and bearer auth; ACME has OAuth
introspection and JWT verifiers.

## Decision (current position)

Four topologies, one codebase, selected by mounts in config:

1. **Local in-repo**: stdio server launched by the client; mounts `personal` (`~/.ynm/store.git`)
   and `project` (this repo's shared refs). Sync via the repo's remote.
2. **Personal global**: same, without a project mount. Works outside any git repo.
3. **Dedicated shared repo**: a memory-only bare repo (on disk, GitHub, GitLab, Bitbucket) mounted
   as `org`; stdio locally or HTTP.
4. **Hosted service**: Docker image running the HTTP transport in front of a bare repo (or the
   sqlite provider). The server is the single writer, so no ref contention; clients never need
   git. Auth: bearer for dev, OAuth introspection or JWT via JWKS for production. Includes the
   dream worker and a scheduler.

`ynm init` steps (project): detect repo/worktree; create root commit if none; write
`.ynm/config.json` (mounts, index, redaction, dream thresholds); add `remote.<r>.fetch`
`refs/notes/ynm/shared/*:refs/ynm-remote/shared/*` (not forced, into a temp namespace) and
`remote.<r>.push refs/notes/ynm/shared/*`; install `pre-push` (run `ynm sync`) and
`post-checkout` (no-op guard, prints reminder if refs missing) hooks; build the index; print the
CLAUDE.md / AGENTS.md snippet. `--personal` and `--bare <target>` variants create the root commit
in a fresh bare repo. `ynm mcp install --client <name>` writes client config.

`ynm doctor`: refspecs present, hooks present, anchor reachable, shards parse, index fresh,
divergence per shard, personal refs absent from push refspecs, node/git versions.

Config precedence (copied from ACME): defaults → `~/.ynm/config.json` → `<repo>/.ynm/config.json`
→ `<worktree>/.ynm/config.local.json` → env `YNM_*`.

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
- Existing ACME data: `ynm import --from-acme` reads `refs/notes/acme-*` JSONL and writes records
  whose provenance points at the old entry (thoughts → episodic or semantic, rules and standards →
  procedural, the rest skipped or archived).
- Monorepos: several projects share the root commit and are separated by namespace (ADR-001).
- Forks and mirrors: notes do not follow unless the fetch refspec is configured there; the doctor
  checks.
- Many writers on one shard: push retries rise; that is the signal to move that store to the
  hosted single-writer topology, not a blocker for starting local.

## Alternatives considered

- Hosted-only (like Mem0 cloud). Rejected: local-first is the point of git notes.
- Local-only. Rejected: production agents without a git checkout need the HTTP shape.

## Decided

- The hosted service is a **v1, first-class** topology (2026-09-28): a central memory store that
  agents connect to over Streamable HTTP is part of the deliverable, not a later addition.
- Design constraints that follow, applied from Phase 1: the server is stateless; the service layer
  never assumes a local checkout or a working tree; every provider works against a bare repo; the
  HTTP transport ships with the MCP server (Phase 3), with auth hardening, Docker, scheduler and
  operations docs in Phase 5.

## Consequences

- The hosted service needs its own operational docs: backups (`git bundle --all`), key rotation,
  scaling (one writer per store), and how local clones sync with a hosted store (the hosted repo
  is simply their remote).
- A client that talks to the hosted store and also has a local project mount gets two mounts;
  recall spans both and labels the origin.

## Open questions

- Client installation is its own seam, see ADR-013 (Claude Code, Copilot CLI, OpenCode, Pi, ynh;
  Cursor dropped).

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M3): both transports ship. stdio through `serveStdio`; Streamable HTTP through
  `createMcpHandler` plus `toNodeHandler` with a fresh server per request, host and origin
  validation in front, localhost CORS, static bearer and `/health`. The MCP server opens the
  service once per process and relies on index freshness for writes from elsewhere. A hosted
  server runs with `--no-personal` against a bare repo; proven by the protocol and HTTP tests.
- 2026-09-29 (M3): `memory_sync` against a repo with no remote reports the missing remote in the
  result instead of failing.
- 2026-09-29 (M1): the installed pre-push hook runs `ynm sync --quiet`, and sync itself pushes,
  so without a guard the hook re-enters sync forever (it did, under pnpm where `ynm` is on PATH).
  Sync now sets `YNM_SYNC_IN_PROGRESS=1` on its own git calls and the hook exits when it sees it.
- 2026-09-29 (M1): `ynm init` adds `HEAD` to `remote.<r>.push` before the shared-notes refspec
  when no push refspec exists, because an explicit push refspec otherwise replaces git's default
  and plain `git push` would stop pushing the branch.
- 2026-09-29 (M1): the personal store's anchor is recomputed from its `main` root on every open
  rather than cached in config; cheap and immune to the notes-root confusion above.
- 2026-09-29 (M5): hosted auth ships as three verifiers behind the SDK's `OAuthTokenVerifier`
  seam: static tokens, RFC 7662 introspection (cached, copied in spirit from ACME) and JWT via
  JWKS with jose. The transport uses `verifyBearerToken` and answers RFC 6750 challenges
  (401 `invalid_token`, 403 `insufficient_scope`); verifiers must throw the SDK's `OAuthError`
  or the failure becomes a 500, and every `AuthInfo` needs an expiry or the SDK rejects it.
  Mode is chosen from the environment (`YNM_JWKS_URL` > `YNM_OAUTH_INTROSPECTION_URL` >
  `YNM_MCP_TOKEN` > none).
- 2026-09-29 (M5): the dream worker is a scheduler inside the hosted process (`--dream-every`,
  `--sync-every`), never overlapping runs, stats on `/health`. One binary: `ynm serve` starts
  the MCP server (stdio by default, `--http` hosted) and is what client adapters register;
  `ynm-mcp` remains as an alias for the server package. Docker image (`Dockerfile`, alpine,
  git-daemon optional) and the compose demo under `infra/docker/` prove the topology: an agent
  with no git and a developer clone that syncs through the container. Binding to `0.0.0.0`
  disables the Host header check (`--allow-host *`) since a container's own hostname is unknown.
- 2026-09-29 (M5): operations doc at `docs/operations.md` (auth modes, rotation, `git bundle`
  backups, one writer per store, clones as remotes). A Gitea container test shows two clones
  syncing a dedicated shared repo through a forge with concurrent writes merged (NFR-6).
