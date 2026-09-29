# ADR-014: Evals and benchmarks tracked at all times

Status: accepted (2026-09-29)
Satisfies: NFR-1, NFR-2, NFR-3, NFR-10, NFR-16

## Context

Memory systems fail quietly: recall gets slower as stores grow, a ranking tweak drops the right
memory out of the top ten, a consolidation change merges things that should stay apart, and the
agent stops calling `memory_recall` after a prompt edit. The published benchmarks (LoCoMo,
LongMemEval, BEAM) measure end-to-end question answering over long histories; they are useful but
slow and LLM-dependent. Karpathy's wiki critics' main complaint was "no benchmarks". mcp-toolkit
has an evals runner, an LLM judge and reporters worth copying, and a live eval that checks whether
a model given the guidance actually picks the right tool.

## Decision

A standing `packages/evals` with three tiers, all runnable locally and in CI. Gating is
relative: a number is compared with the same suite's stored baseline and a gross regression
fails; absolute budgets are reported, not gating, and are calibrated on a named reference
machine (an Apple Silicon laptop for 0.1.0). Milestone gates live in code from the first
commit: one file per milestone at `packages/evals/src/gates/m<n>.gate.test.ts`, each check
named up front as an `it.todo` until built; `pnpm gate M<n>` runs one and a milestone closes
only when its gate is green with zero todos. CI runs the gate named by the `YNM_MILESTONE`
repository variable, and the release workflow runs the release gate.

### Tier 1: fast, deterministic, every PR (minutes, no model)

| Suite | What it measures | Gate |
|---|---|---|
| Semantics | Fold correctness: supersede, tombstone, snapshot, links; property-based tests over random op sequences | any failure |
| Merge and concurrency | Two-clone sync never loses a record; N concurrent local writers lose nothing; `cat_sort_uniq` reorder tolerance | any loss |
| Latency, seeded stores | p50 and p95 for `remember`, `recall` (lexical), `context`, cold full load, incremental index update, `sync` (local bare remote), at 1k, 10k and 100k memories from a deterministic generator | p95 over 3x baseline |
| Retrieval quality, synthetic | recall@1/5/10 and MRR on a generated corpus with known relevant memories per query, per type and namespace, with and without reranker (reranker uses the `heuristic` Judge here) | drop of more than 2 points vs baseline |
| Parity | Every MCP tool has a CLI command and the same schema; every client adapter passes its golden test | any failure |
| Hosted | The Docker image serves a bare repo over HTTP with a bearer challenge, shares memory between two git-less clients, runs the dream worker on its timer, consolidates over HTTP, and syncs both ways with a local clone; a Gitea container plays the forge for two syncing clones with concurrent writes; the compose demo runs end to end | any failure (needs a Docker daemon; `pnpm test:hosted`, excluded from `pnpm test`) |

Budgets at 100k memories on the reference machine, frozen per release in
`packages/evals/baselines/<version>.json`: remember 150 ms p95 (each append is seven git spawns;
the lever if it matters is batching records per append), recall 200 ms p95 (the OR-of-terms
FTS5 query joined to the metadata table does not take FTS5's fast rank path; the lever is
ordering by the FTS `rank` column without the join), context 200 ms, cold load and fold 8 s,
incremental index update 150 ms, sync of one 1k shard against a local bare remote 2 s.

### Tier 2: model-backed, opt-in (requires keys)

| Suite | What it measures |
|---|---|
| Consolidation quality | Dedupe precision and recall, contradiction detection, promotion decisions, on a labelled synthetic set; per Judge implementation (`typesafe`, `writer-emulated`, `heuristic`) so calibration is visible |
| Summary faithfulness | Reflective summaries checked by the cascade-style Noul battery against their sources; rate of unsupported claims |
| Reranker lift | recall@k with real Judge vs lexical only, on the synthetic corpus |
| Guidance efficacy | Scripted sessions: given the client guidance and a task, does the agent call `memory_remember` and `memory_recall` when it should and not when it shouldn't (copied from mcp-toolkit's live guidance eval; LLM judge scores the transcript) |
| Cost | Tokens and dollars per dream run per 1k memories, per Judge and Writer |

Calibrated (paid) evals run only when opted in with `YNM_EVAL_CALIBRATED=1` in addition to the
key, because the eval support loads the repo `.env` and unsetting a variable in the shell is not
enough. Paid usage is capped in code: `SpendGuard` in `@ynm/models` reserves an estimate before
every metered call and charges actual usage after, and crossing the budget throws instead of
spending. The process default is 2M input tokens (`YNM_TOKEN_BUDGET`); the evals use their own
250k-token guard (`YNM_EVAL_TOKEN_BUDGET`, about $0.01 at Jev list price) and small corpora by
default (60 memories for consolidation, 120 for the cleanup run, 10 queries for rerank); bigger
runs are an explicit choice. A pair judgment costs about 700 input tokens, so 250k buys roughly
350 pairs. Candidate-pair generation is lexical-only (`rerank: false`) and the pair cap applies
per pass, so a configured reranker cannot leak judge calls into consolidation and dedupe cannot
starve the contradiction pass. Baseline-writing runs (`YNM_WRITE_BASELINE=1`) do not assert
regression against the numbers they are replacing.

The heuristic (no-model) judge is the floor a calibrated judge is measured against: on the
300-memory corpus dedupe precision 0.09 and recall 0.57 (it flags, never acts), contradiction 0
(it needs a negation cue; value swaps are invisible to it), promotion accuracy 0.65.

### Tier 3: public benchmarks, per release

LoCoMo (ten conversations, 1986 questions, CC BY-NC 4.0) and LongMemEval-S (500 instances, each
its own haystack of about 50 sessions, MIT) run through one driver in `packages/evals/src/tier3`.
Ingest is deliberately naive for 0.1.0: one episodic memory per turn, tagged with its session and
turn ids, dated by the session, in a fresh in-memory store per case. Every question is answered
by `recall` at k = 10 with the clock set to the question's date. Two metrics:

- **Evidence recall at k**, no model needed: the fraction of the benchmark's evidence (turn ids
  for LoCoMo, session ids for LongMemEval) present among the retrieved memories. This runs
  whenever the cached dataset exists and is the number to watch for retrieval changes.
- **Answer accuracy**, opt-in (`YNM_BENCH_ANSWER=1`) and bounded (`YNM_BENCH_ANSWER_LIMIT`,
  default 20 per dataset): the Writer answers from the retrieved memories, the Judge grades the
  hypothesis against the gold answer (a Noul; abstention questions ask whether the hypothesis
  declined to answer). The report records the exact writer and judge.

Datasets are downloaded on demand into `~/.ynm/bench` (`YNM_BENCH_DIR`), never committed.
Reports are committed per release under `packages/evals/reports/<version>/<dataset>.json` with
the dataset's sha256 and the setup; a retrieval-only refresh keeps the previous paid answers and
a small answering run never shrinks the retrieval sample. Numbers are compared only with our own
previous releases: vendor-reported scores use different judges, extraction-based ingest and
answering models, and are not directly comparable.

### Mechanics

- Datasets: a seeded, deterministic generator for synthetic corpora. It produces realistic
  templated memories (entity and value slots, several paraphrases per claim) with known
  duplicates (another paraphrase with the same value), contradictions (the same entity with a
  different value), subjects and relevant-query pairs. The first calibrated run exposed the
  original word-salad corpus, not the judge: Jev correctly called "duplicates" that differed in
  a random second sentence related-not-same.
- Runner, judge and reporters copied in spirit from mcp-toolkit `packages/testing` into
  `@ynm/evals`; vitest for every tier.
- Baselines live in `packages/evals/baselines/<version>.json`; a PR that moves a gated number
  must update the baseline explicitly in the same PR, which makes regressions a review decision.
- Entry points: `pnpm test` (tier 1 without latency and hosted), `pnpm bench` (latency),
  `pnpm test:hosted`, the tier 2 suites by path, `pnpm bench:public` (tier 3), `pnpm gate M<n>`.

## Alternatives considered

- Unit tests only. Rejected: they cannot see gradual latency or quality drift.
- Public benchmarks only. Rejected: slow, model-dependent, and they do not test merge, concurrency
  or guidance.

## Consequences

- The synthetic generator and Tier 1 harness were built alongside the store, not after.
- Every ADR that changes ranking, consolidation or storage must state which suite catches a
  regression.
- Budgets are numbers in a file, reviewed at each release, never in prose.
- Tier 3's turn-level ingest sets a floor. An extraction-based ingest (a Writer distilling facts
  per session) is the obvious next variant and must be reported as a separate setup, never
  merged into the same number.

## Open questions

- The retrieval suite does not yet report recall broken down per type and namespace.
- Results are not yet written back as `episodic` memories into the ynm repo's own store
  (`namespace: project/ynm/bench`); the JSON reports are the record for now.

## History

- 2026-09-28 (M0): milestone gates as `it.todo` checks from the first commit; CI runs the
  gate named by `YNM_MILESTONE`.
- 2026-09-29 (M1): first latency baselines; remember budget revised to 150 ms; relative gating.
- 2026-09-29 (M2): recall baselines; recall budget at 100k revised to 200 ms.
- 2026-09-29 (M4): realistic templated corpus replaced the word-salad generator; calibrated
  evals opt-in after two unintended runs; heuristic floors recorded; `SpendGuard` caps paid
  usage; lexical-only candidate generation and per-pass pair caps.
- 2026-09-29 (M5): hosted integration tests (Docker, Gitea, compose demo) as a tier 1 suite.
- 2026-09-29 (M6): tier 3 driver for LoCoMo and LongMemEval-S with evidence recall and opt-in
  bounded answering; reports committed per release.
