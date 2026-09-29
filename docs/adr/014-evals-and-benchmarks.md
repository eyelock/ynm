# ADR-014: Evals and benchmarks tracked at all times

Status: draft
Satisfies: NFR-1, NFR-2, NFR-3, NFR-10, NFR-16

## Context

Memory systems fail quietly: recall gets slower as stores grow, a ranking tweak drops the right
memory out of the top ten, a consolidation change merges things that should stay apart, and the
agent stops calling `memory_recall` after a prompt edit. The published benchmarks (LoCoMo,
LongMemEval, BEAM) measure end-to-end question answering over long histories; they are useful but
slow and LLM-dependent. Karpathy's wiki critics' main complaint was "no benchmarks". mcp-toolkit
has an evals runner, an LLM judge and reporters worth copying, and a live eval that checks whether
a model given the guidance actually picks the right tool.

## Decision (current position)

A standing `packages/evals` with three tiers, all runnable locally with `ynm bench` and in CI.

### Tier 1: fast, deterministic, every PR (minutes, no model)

| Suite | What it measures | Gate |
|---|---|---|
| Semantics | Fold correctness: supersede, tombstone, snapshot, links; property-based tests over random op sequences | any failure |
| Merge and concurrency | Two-clone sync never loses a record; N concurrent local writers lose nothing; `cat_sort_uniq` reorder tolerance | any loss |
| Latency, seeded stores | p50 and p95 for `remember`, `recall` (lexical), `context`, cold full load, incremental index update, `sync` (local bare remote), at 1k, 10k and 100k memories from a deterministic generator | p95 over budget |
| Retrieval quality, synthetic | recall@1/5/10 and MRR on a generated corpus with known relevant memories per query, per type and namespace, with and without reranker (reranker uses the `heuristic` Judge here) | drop of more than 2 points vs baseline |
| Parity | Every MCP tool has a CLI command and the same schema; every client adapter passes its golden test | any failure |

Initial latency budgets, to be calibrated on real hardware in Phase 1 and then frozen per release:

| Operation | Store size | p95 budget |
|---|---|---|
| `remember` (git-notes, local, no Judge) | any | 50 ms |
| `recall` lexical | 100k | 100 ms |
| `recall` with Judge rerank (network excluded) | 100k | 500 ms |
| `context` (pinned block) | 100k | 200 ms |
| cold full load and fold | 10k | 1 s |
| cold full load and fold | 100k | 8 s |
| incremental index update per append | any | 20 ms |
| `sync` one shard against a local bare remote | any | 2 s |

### Tier 2: model-backed, nightly and on demand (requires keys)

| Suite | What it measures |
|---|---|
| Consolidation quality | Dedupe precision and recall, contradiction detection, promotion decisions, on a labelled synthetic set; per Judge implementation (`typesafe`, `writer-emulated`, `heuristic`) so calibration is visible |
| Summary faithfulness | Reflective summaries checked by the cascade-style Noul battery against their sources; rate of unsupported claims |
| Reranker lift | recall@k with real Judge vs lexical only, on the synthetic corpus and on public sets |
| Guidance efficacy | Scripted sessions: given the client guidance and a task, does the agent call `memory_remember` and `memory_recall` when it should and not when it shouldn't (copied from mcp-toolkit's live guidance eval; LLM judge scores the transcript) |
| Cost | Tokens and dollars per dream run per 1k memories, per Judge and Writer |

### Tier 3: public benchmarks, per release

LoCoMo and LongMemEval-S adapted through a driver that feeds conversation sessions into
`memory_remember` and answers questions through `memory_recall` plus a fixed answering model.
Numbers are reported with the exact judge setup and compared only to our own previous releases;
vendor-reported scores use different judges and are not directly comparable.

### Mechanics

- Datasets: a seeded, deterministic generator for synthetic corpora (memories with known
  duplicates, contradictions, subjects and relevant-query pairs); public sets downloaded on
  demand and cached, never committed.
- Runner, LLM judge and reporters copied from mcp-toolkit `packages/testing` (evals, judge,
  reporters) into `@ynm/evals`; vitest `bench` project for Tier 1.
- Results are written as JSON artefacts in CI and, dogfooding, as `episodic` memories with
  `data` in the ynm repo's own shared store under `namespace: project/ynm/bench`, so trends
  are queryable with `memory_recall`.
- Baselines live in `packages/evals/baselines/<version>.json`; a PR that moves a gated number
  must update the baseline explicitly in the same PR, which makes regressions a review decision.
- `ynm bench --tier 1|2|3 --size 10k --json` is the single entry point; CI calls the same.

## Alternatives considered

- Unit tests only. Rejected: they cannot see gradual latency or quality drift.
- Public benchmarks only. Rejected: slow, model-dependent, and they do not test merge, concurrency
  or guidance.

## Consequences

- The synthetic generator and Tier 1 harness are built in Phase 1 alongside the store, not after.
- Every ADR that changes ranking, consolidation or storage must state which suite catches a
  regression.
- Budgets are numbers in a file, reviewed at each release, never in prose.

## Decided

- CI gates on relative regression against a same-run baseline; absolute budgets are reported, not
  gating, and are calibrated on a named reference machine (default, 2026-09-28).
- Tier 2 runs against stdio and the hosted topology (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M1): first baselines recorded on the reference machine (Apple Silicon laptop,
  `packages/evals/baselines/0.1.0.json`): remember p95 83 ms at 1k, 93 ms at 10k, 110 ms at 100k;
  cold load and fold p95 43 ms at 1k, 83 ms at 10k, 585 ms at 100k; sync of a 1k store against a
  local bare remote p95 316 ms. Against the draft budgets: load and fold is well inside (585 ms vs
  8 s at 100k); a single remember is over (about 90 ms vs 50 ms) because each append is seven git
  spawns. Budget for remember revised to 150 ms p95; the lever if it matters is batching records
  per append, not fewer spawns. Gating is relative (3x p95 regression fails), as decided.
- 2026-09-29 (M2): recall baselines on the reference machine: reindex 284 ms at 10k and 2.3 s at
  100k; recall p95 28 ms at 10k and 158 ms at 100k; context p95 19 ms and 66 ms; remember with
  index update p95 84 ms and 111 ms; recall@10 1.0 and MRR 0.94 on the 2k synthetic corpus.
  The draft 100 ms recall budget at 100k is revised to 200 ms: the OR-of-terms FTS5 query joined
  to the metadata table does not take FTS5's fast rank path. Levers if it matters: order by the
  FTS `rank` column without the join, or push metadata filters into FTS columns.
- 2026-09-29 (M4): the first calibrated consolidation run exposed the synthetic corpus, not the
  judge: "duplicates" shared one sentence and differed in a second random-word sentence, so Jev
  correctly called them related-not-same (precision 1.0, recall 0.26). The generator now produces
  realistic templated memories (entity and value slots, several paraphrases per claim); a
  duplicate is another paraphrase with the same value, a contradiction the same entity with a
  different value. Retrieval baselines were re-recorded on the new corpus (recall@10 0.97).
- 2026-09-29 (M4): calibrated evals are opt-in (`YNM_EVAL_CALIBRATED=1`) in addition to the key,
  after two unintended runs cost about $0.08: the eval support loads the repo `.env`, so
  unsetting the variable in the shell was not enough. Baseline-writing runs no longer assert
  regression against the numbers they are replacing.
- 2026-09-29 (M4): heuristic (no-model) baselines on the 300-memory corpus: dedupe precision 0.09
  recall 0.57 (it flags, never acts), contradiction 0 (it needs a negation cue; value swaps are
  invisible to it), promotion accuracy 0.65. These are the floor a calibrated judge is measured
  against.
- 2026-09-29 (M4): paid usage is capped in code. `SpendGuard` in `@ynm/models` reserves an
  estimate before every metered call and charges actual usage after; crossing the budget throws
  instead of spending. The process default is 2M input tokens (`YNM_TOKEN_BUDGET`); the evals use
  their own 250k-token guard (`YNM_EVAL_TOKEN_BUDGET`, about $0.01 at Jev list price) and small
  corpora by default (60 memories for consolidation, 120 for the cleanup run, 10 queries for
  rerank). Bigger runs are an explicit choice. Measured: a pair judgment costs about 700 input
  tokens with the current question texts, so 250k tokens buys roughly 350 pairs; the guard was
  seen stopping two oversized runs at the cap, a cent each, in thirteen seconds. The first such
  overrun was a real leak, not eval size: candidate-pair generation went through `recall`, which
  with a calibrated judge configured ran the reranker (fifteen judge calls per memory). Candidate
  generation is now lexical-only, and the pair cap applies per pass so dedupe cannot starve the
  contradiction pass.
- 2026-09-28 (M0): milestone gates exist in code from the first commit. One file per milestone
  at `packages/evals/src/gates/m<n>.gate.test.ts`; each check is named now and is an `it.todo`
  until built. `pnpm gate M<n>` runs one; a milestone closes only when its gate is green with
  zero todos. CI runs the gate named by the `YNM_MILESTONE` repository variable (default M0).
