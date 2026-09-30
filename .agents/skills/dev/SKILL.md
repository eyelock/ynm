---
name: ynm-dev
description: Develop a feature in ynm: where code lives, how tools and CLI commands stay in parity, and what a change must ship with.
---

# dev

- Business logic lives only in `packages/service`. An MCP tool is one entry in `TOOL_SPECS`
  (`packages/service/src/tools.ts`); the CLI command is generated from the same Zod schema, and the
  parity test in `packages/evals/src/tier1/parity` fails if they diverge.
- Store providers implement `RecordLog` and must pass `runRecordLogConformance`
  (`packages/store/src/testing/conformance.ts`). Indexes implement `MemoryIndex` and pass the index
  conformance suite.
- A change ships with: unit tests in its package, a tutorial step with an Expected block when it is
  user-visible (`docs/tutorial`), a how-to or reference update, and a new ADR if it changes a decision.
- Do not put milestone ids in code or tests. Keep secrets out of config; they load from `~/.ynm/env`
  or the repo `.env`.
- Verify with `make verify`, then `make test-tutorials`.
