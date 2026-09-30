# ADR-011: What is copied from ACME and mcp-toolkit

Status: accepted (2026-09-29)
Satisfies: NFR-10, NFR-12

## Context

Both old repos are unpublished. ACME (a private repository, last commit
2026-01-14, SDK 1.x) has a good idea and a weak git-notes implementation. mcp-toolkit
(private) has a current-spec transport layer on its
unmerged `spec-update` branch (SDK v2, protocol 2026-07-28). Neither depends on the other.

## Decision

Reuse by **copying files into ynm and owning them**. No workspace dependency, vendored tree or
submodule on either repo. Copied files get ynm package names and are refactored freely.

Copy from mcp-toolkit (`spec-update` branch):

- `packages/mcp/src/transport/{stdio,http,index}.ts` → `@ynm/mcp/transport`
- `packages/core/src/storage/*` (provider pattern, file provider, conformance suite) →
  `@ynm/store/working`
- `packages/mcp/src/strategy/index.ts`, `elicitation/helpers.ts` → `@ynm/mcp/delegation`
- `packages/mcp/src/spec/logging.ts` → `@ynm/service/logging`
- Makefile, `scripts/mcp-install.sh`, shared tsconfig/vitest/esbuild configs

The mcp-toolkit hook composer (`packages/core/src/hooks/*`) is not copied: guidance is plain
markdown per tool appended to results (ADR-008).

Copy from ACME:

- `packages/storage-git-notes/src/{git-operations,git-validation}.ts` → `@ynm/store/git`
  (make async, parameterise refs, add plumbing writes and `cat-file --batch`)
- `packages/core/src/git/worktree.ts` → `@ynm/store/git/worktree.ts`
- `packages/core/src/config/*` and `adapters/{inquirer,elicitation}.ts` → `@ynm/service/config`
- `packages/cli/src/lib/schema-to-flags.ts` → `@ynm/cli/lib`
- `packages/mcp/src/auth/*`, `pagination.ts`, `progress.ts`, `cancellation.ts` → `@ynm/mcp`
  (verify against SDK v2 first)
- `packages/model/src/prompts/loader.ts`, `scripts/bundle-prompts.ts` → `@ynm/model/prompts`
- Prompt content `thought-creation.md`, `rule-creation.md`, `standard-creation.md`,
  `session-management.md` as seeds, rewritten
- `packages/storage-fs/src/fs-storage.ts` (atomic write, lockfile) → `@ynm/store/fs`
- `packages/storage-git-notes/src/__helpers__/git-test-repo.ts` → test helpers
- Tooling: pnpm, turbo, biome, vitest projects with coverage merge, changesets

Not copied: ACME domain schemas, state machine, hook wiring, reporting, plan/PR tools,
Dockerfiles, AWS infra; mcp-toolkit toolkit package, its CLI, workflow tracker, hook composer,
demo sampling and resource templates.

Baseline versions: Node 22 LTS or newer, `@modelcontextprotocol/server` and `/node` 2.x,
Zod 4 (native `toJSONSchema`), oclif 4, vitest 4, biome 2, TypeScript 6.

## Consequences

- Copied code is reviewed on entry: the ACME git code has synchronous `execFileSync` and a shell
  interpolation in `notes-sync.ts` that must not survive the copy.
- Coverage thresholds are set per package, starting at 80% for new code.

## Open questions

None.

## History

- No addenda were recorded during the build; accepted as drafted on 2026-09-28.
