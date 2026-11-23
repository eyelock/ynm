# ADR-007: Privacy boundary and sync

Status: accepted (2026-09-29)
Satisfies: FR-2, FR-16, FR-18, NFR-5

## Context

The predecessor project's privacy guide described three modes (local-only, personal fork, team) but the code had one
set of refs and a forced fetch refspec, and its docs wrongly claimed prompts were not stored. Claude
Code separates human-written tiers (managed, user, project, local) from machine-written auto memory
kept outside the repo. Letta and Mem0 scope by ids but keep one store.

## Decision

- **Personal memory** always stays in the user's own store, `~/.ynm/store.git` (a bare repo with
  one root commit). There is no `personal/*` ref namespace in project repos: the ref layout in
  ADR-003 has `refs/notes/ynm/distributed/*` in project and org repos, and `refs/notes/ynm/personal/*`
  only in `~/.ynm/store.git`. So a hand-run `git push origin 'refs/notes/*'` or a mirror job
  cannot leak personal memory. Personal memory about a project is namespaced (`project/ynm`)
  inside the personal store; recall spans mounts. Pushing personal memory anywhere requires an
  explicit `ynm sync --mount personal --remote <private-remote>`; a plain `ynm sync` never syncs it. This mirrors the User → Project
  layering every LLM vendor uses for configuration (Claude Code's `~/.claude` vs `.claude/`, and
  its per-project auto-memory kept under the home directory).
- **Distributed memory** lives in `refs/notes/ynm/distributed/*` in the project repo or in a
  dedicated shared memory repo. `ynm init` adds a fetch refspec for `distributed/*` only, and a
  pre-push hook that runs `ynm sync`; notes are never pushed by a push refspec, so a plain
  `git push` does not race the sync.
- The `level` is fixed at write time and enforced by the mount table (ADR-004): a `personal` record
  can only be appended to a personal log.
- Promotion personal → distributed is `ynm promote <memoryId>`: a new `create` record on the
  shared log with a `derives-from` link back; the personal original is untouched.
- Redaction hook: a configurable list of patterns (secrets, emails, tokens) is applied before any
  write to a distributed log and before any consolidation write. Rejected content is reported, not
  silently dropped.
- Sync algorithm per shard: fetch into a remote-tracking namespace (`refs/notes/ynm-remote/<remote>/`),
  fast-forward or `notes merge -s cat_sort_uniq`, push, retry on rejection. Never a forced fetch
  into the working refs. `ynm doctor` reports divergence per shard.
- Sharing is chosen, never defaulted. A new memory that names no level goes to the personal level;
  on a store with no personal level (a hosted server) it is refused rather than shared, and the
  server's instructions tell agents to ask before sharing. Edits to memories already shared are
  unaffected. Connecting to a hosted store is the agreement that what is shared there is shared;
  review before sharing is a local ynm's distributed mount and `ynm sync`.

## Alternatives considered

- One store with per-record visibility flags. Rejected: one accidental push leaks everything.
- Encrypting personal notes inside the shared refs. Rejected for v1: key management outweighs the
  benefit; separate refs are simpler and auditable.

## Consequences

- Recall spanning both levels merges results from two logs and labels each hit with its level.
- Users get a personal store with zero setup (NFR-14); teams opt in to shared.

## Open questions

None.

## History

- Accepted as drafted on 2026-09-28; no addenda were recorded during the build.
- 2026-10-03: sharing is chosen, never defaulted (now in the Decision).
- The Decision absorbs the corrections once listed here: the personal sync command is
  `ynm sync --mount personal`, there is no `--personal` flag, and the shared ref directory is
  `distributed/`, not `shared/`.
