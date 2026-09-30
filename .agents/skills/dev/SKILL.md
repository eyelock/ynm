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
- Client integrations are adapters in `packages/service/src/clients/`; `ynm init` runs the
  project-scope plan of every adapter whose project footprint is present, so a new adapter or a new file it writes shows up in
  init's report and in the tutorials. Agent hooks (`ynm hook`) live in
  `packages/service/src/hooks/`; a hook must print only JSON and always exit 0.
- Do not put milestone ids in code or tests. Keep secrets out of config; they load from `~/.ynm/env`
  or the repo `.env`.
- Verify with `make verify`, then `make test-tutorials`.
