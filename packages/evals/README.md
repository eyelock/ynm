# @ynm/evals

Standing evals and milestone gates (ADR-014).

- `src/gates/m<n>.gate.test.ts`: one file per milestone. Each check is an `it.todo` until the
  milestone builds it; the milestone closes when the file is green with zero todos.
  Run one with `make gate M=M1` from the repo root.
- `src/tier1/`: deterministic suites that gate every PR (semantics, merge, latency, retrieval, parity).
- `src/tier2/`: model-backed suites, nightly (consolidation, faithfulness, rerank, guidance, cost).
- `src/tier3/`: public benchmark drivers, per release (LoCoMo, LongMemEval).
- `baselines/`: gated numbers per version; changing one is an explicit PR change.

## Cost guard

Tier 2 suites that use a paid model run only with `YNM_EVAL_CALIBRATED=1` in addition to the
key, use small corpora by default (`YNM_EVAL_SIZE=60`, `YNM_EVAL_CLEANUP_SIZE=120`), and are
capped by `YNM_EVAL_TOKEN_BUDGET` (default 250,000 input tokens per suite). The cap is enforced
inside the model clients: crossing it throws instead of spending. Raise any of these
deliberately, never by default.
