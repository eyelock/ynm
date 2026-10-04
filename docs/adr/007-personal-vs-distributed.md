# ADR-007: Privacy boundary and sync

Status: accepted (2026-09-29)
Satisfies: FR-2, FR-16, FR-18, NFR-5

## Context

ACME's privacy guide described three modes (local-only, personal fork, team) but the code had one
set of refs and a forced fetch refspec, and its docs wrongly claimed prompts were not stored. Claude
Code separates human-written tiers (managed, user, project, local) from machine-written auto memory
kept outside the repo. Letta and Mem0 scope by ids but keep one store.

## Decision

- **Personal memory** always stays in the user's own store, `~/.ynm/store.git` (a bare repo with
  one root commit). There is no `personal/*` ref namespace in project repos: the ref layout in
  ADR-003 has `refs/notes/ynm/shared/*` in project and org repos, and `refs/notes/ynm/personal/*`
  only in `~/.ynm/store.git`. So a hand-run `git push origin 'refs/notes/*'` or a mirror job
  cannot leak personal memory. Personal memory about a project is namespaced (`project/ynm`)
  inside the personal store; recall spans mounts. Pushing personal memory anywhere requires an
  explicit `ynm sync --personal --remote <private-remote>`. This mirrors the User → Project
  layering every LLM vendor uses for configuration (Claude Code's `~/.claude` vs `.claude/`, and
  its per-project auto-memory kept under the home directory).
- **Distributed memory** lives in `refs/notes/ynm/shared/*` in the project repo or in a
  dedicated shared memory repo. `ynm init` adds fetch and push refspecs for `shared/*` only.
- The `level` is fixed at write time and enforced by the mount table (ADR-004): a `personal` record
  can only be appended to a personal log.
- Promotion personal → distributed is `ynm promote <memoryId>`: a new `create` record on the
  shared log with a `derives-from` link back; the personal original is untouched.
- Redaction hook: a configurable list of patterns (secrets, emails, tokens) is applied before any
  write to a distributed log and before any consolidation write. Rejected content is reported, not
  silently dropped.
- Sync algorithm per shard: fetch to temp ref, `notes merge -s cat_sort_uniq`, push, retry. Never a
  forced fetch into the working refs. `ynm doctor` reports divergence per shard.

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

- No addenda were recorded during the build; accepted as drafted on 2026-09-28.
- 2026-09-29: correction: the command that pushes personal memory is `ynm sync --mount personal --remote <private-remote>`; there is no `--personal` flag on `sync`.
- 2026-10-03: sharing is chosen, never defaulted. A new memory that names no level goes to the
  personal level; on a store with no personal level (a hosted server) it is refused rather than
  shared, and the server's instructions tell agents to ask before sharing. Edits to memories
  already shared are unaffected. Connecting to a hosted store is the agreement that what is shared
  there is shared; review before sharing is a local ynm's distributed mount and `ynm sync`.
