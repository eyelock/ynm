# @ynm/evals

Standing evals and milestone gates (ADR-014).

- `src/gates/m<n>.gate.test.ts`: one file per milestone. Each check is an `it.todo` until the
  milestone builds it; the milestone closes when the file is green with zero todos.
  Run one with `pnpm gate M1` from the repo root.
- `src/tier1/`: deterministic suites that gate every PR (semantics, merge, latency, retrieval, parity).
- `src/tier2/`: model-backed suites, nightly (consolidation, faithfulness, rerank, guidance, cost).
- `src/tier3/`: public benchmark drivers, per release (LoCoMo, LongMemEval).
- `baselines/`: gated numbers per version; changing one is an explicit PR change.
