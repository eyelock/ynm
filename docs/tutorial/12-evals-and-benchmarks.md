# Evals and Benchmarks

ynm measures itself all the time: tests on every change, latency and retrieval numbers compared
with stored baselines, milestone gates, and two public benchmarks run before each release. This
tutorial runs each layer from a checkout and shows where the numbers live and how to read them.

Unlike the others, this one works in a checkout of the repository rather than in a sandbox: it
runs the project's own test tooling. Every command here is marked, and skipped by the tutorial
evals unless `YNM_REPO` is set to the path of your checkout.

## Prerequisites

A checkout of the repository with dependencies installed and built, as in the
[install instructions](README.md#install). In your shell, point `YNM_REPO` at it, for example
with `export YNM_REPO=$HOME/src/ynm`, using the path of your own checkout. Everything below starts
by changing into it.

## Run the tests

`make test` runs every package's tests through turbo, the fast deterministic tier of the evals
included: fold semantics, merge and concurrency, retrieval quality on a synthetic corpus, parity
between the CLI and the MCP tools, the end-to-end demo, and the tutorial smoke tests. It needs no
network and no key.

The tutorials are themselves part of this suite, so the command below removes `YNM_REPO` from
its environment; otherwise this tutorial would run itself.

<!-- tutorial: skip unless YNM_REPO -->

```bash
cd "$YNM_REPO"
env -u YNM_REPO make test
```

Expected: a turbo run that ends with `Tasks: <n> successful, <n> total`, taking about a minute
on a warm cache. Among the output is the retrieval quality suite, which prints its numbers
against their baselines:

```text
metric recall@1@2000: 0.8800 (baseline 0.8800)
metric recall@5@2000: 0.9800 (baseline 0.9800)
metric recall@10@2000: 1.0000 (baseline 1.0000)
metric mrr@2000: 0.9217 (baseline 0.9217)
```

`recall@k` is the fraction of queries whose known-relevant memory is in the top k; `mrr` is the
mean reciprocal rank of that memory. The corpus is generated from a fixed seed, with known
duplicates and contradictions, so the numbers are stable. A drop of more than two points below the
baseline fails the run.

## Run a gate

A gate is a test file that says what a milestone must be able to do. Each check starts as a
`todo` and becomes a real test as the work lands. A milestone is closed only when its gate is
green with zero todos.

<!-- tutorial: skip unless YNM_REPO -->

```bash
cd "$YNM_REPO"
make gate M=M0
```

Expected: five passing checks and nothing pending, ending with `Tests  5 passed (5)`:

```text
 ✓ ... > gate M0: skeleton > repo carries its design record and requirements
 ✓ ... > gate M0: skeleton > ynh plugin manifest parses and declares the ynm MCP server
 ✓ ... > gate M0: skeleton > every package builds to dist with a type declaration
 ✓ ... > gate M0: skeleton > `ynm status --json` reports name and version
 ✓ ... > gate M0: skeleton > `ynm-mcp --version` prints
```

Gates are `M0` to `M6`, one file each under `packages/evals/src/gates`. A gate that still has
todos prints them as pending, so a red or yellow gate reads as a list of what is left to build.

## Measure latency

`make bench` runs the latency suite: how long `remember`, a cold load and fold of the whole log,
`sync` against a local bare remote, `reindex`, `recall` and `context` take on stores of 1,000 and
10,000 memories. It builds those stores on disk, so it takes a little under half a minute; it is
not part of `make test` for that reason. Set `YNM_BENCH_LARGE=1` to add the 100,000-memory sizes,
which take much longer.

<!-- tutorial: skip unless YNM_REPO -->

```bash
cd "$YNM_REPO"
make bench
```

Expected: one line per measurement, in the form
`bench <name>@<size>: p50 <ms>ms p95 <ms>ms (baseline p95 <ms>ms, x<ratio>)`. For example:

```text
bench remember@1000: p50 71.34ms p95 72.67ms (baseline p95 83.16ms, x0.87)
bench load+fold@10000: p50 77.11ms p95 82.24ms (baseline p95 83.39ms, x0.99)
bench sync@1000: p50 217.41ms p95 291.01ms (baseline p95 315.88ms, x0.92)
```

The numbers depend on your machine. Read the ratio at the end: below 1 is faster than the stored
baseline, and a p95 above 3x the baseline fails the run. p50 is the typical call, p95 the slow one
in twenty.

(observed: on 0.1.0 the run ends with one failure, `recall.bench.test.ts > rebuild, recall and
context at 10000`, reporting `expected 0 to be greater than 0`: a recall query in that suite
returned no hits. The `reindex` line prints and the `remember`, `load+fold` and `sync` suites
pass.)

## Where baselines and reports live

Everything is checked in, under `packages/evals`:

```text
baselines/<version>.json          gated numbers: latency percentiles and quality metrics
reports/<version>/<dataset>.json  public benchmark reports, one per dataset per release
```

<!-- tutorial: skip unless YNM_REPO -->

```bash
cd "$YNM_REPO"
ls packages/evals/baselines packages/evals/reports/0.1.0
node -e 'const b = require("./packages/evals/baselines/0.1.0.json"); console.log(b["recall@10000"])'
```

Expected: the baselines directory holds `0.1.0.json` and a README, the reports directory holds
`locomo.json` and `longmemeval-s.json`, and the last command prints one baseline entry:

```text
{
  name: 'recall',
  size: 10000,
  p50Ms: 26.36,
  p95Ms: 28.32,
  samples: 20
}
```

Timing entries carry `p50Ms` and `p95Ms`; quality entries carry a single `value`. The keys are
`<metric>@<size>`, and some carry a suffix for the model behind the number, for example
`dedupe-precision:heuristic@300` against `dedupe-precision:typesafe@300`. The gap between those two
is the point: the no-model heuristic flags but rarely acts correctly, and a calibrated judge does
the job. A baseline is compared, never trusted: changing one is an explicit change in the same
pull request, which makes a regression a review decision.

## Public benchmarks

Two published benchmarks test recall over long conversations: LoCoMo (ten conversations, 1,986
questions) and LongMemEval-S (500 questions, each with its own haystack of about fifty
sessions). ynm ingests each turn as one episodic memory in a fresh store, answers every
question by `recall` at k = 10, and reports **evidence recall**: the fraction of the
benchmark's known evidence present in the top ten. That needs no model.

The datasets are downloaded by you, not shipped, and cached in `~/.ynm/bench` (or wherever
`YNM_BENCH_DIR` points). With no datasets, the command skips cleanly:

<!-- tutorial: skip unless YNM_REPO -->

```bash
cd "$YNM_REPO"
YNM_BENCH_DIR=/tmp/ynm-no-bench make bench-public
```

Expected: both benchmarks marked skipped, and `Tests  2 skipped (2)`.

To run them for real, download the two files (LoCoMo is licensed CC BY-NC 4.0, LongMemEval-S is MIT)
and run the command again. It samples 60 LongMemEval instances by default and is slow, tens of
minutes for the full LoCoMo set; set `YNM_BENCH_DATASETS=1` in your shell to run this step.

<!-- tutorial: skip unless YNM_BENCH_DATASETS -->

```bash
mkdir -p "$HOME/.ynm/bench"
curl -L -o "$HOME/.ynm/bench/locomo10.json" https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
curl -L -o "$HOME/.ynm/bench/longmemeval_s_cleaned.json" https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
cd "$YNM_REPO"
make bench-public
```

Expected: progress lines, then one summary line per benchmark of the form
`LoCoMo evidence recall@10 <n> (full <n>); <report path>; guard spent 0`, and the same for
LongMemEval-S. The run writes a report file for each.

Answer accuracy, where a model answers from the retrieved memories and a judge grades the
answer, is opt-in and small by default because it spends tokens: `YNM_BENCH_ANSWER=1` with
`YNM_BENCH_ANSWER_LIMIT` (default 20 questions per dataset), a writer and a calibrated judge.
Leave it off unless you mean it; the spend guard caps the run in any case.

## Read a report

Reports are plain JSON. The ones committed for 0.1.0 record what was measured and how:

<!-- tutorial: skip unless YNM_REPO -->

```bash
cd "$YNM_REPO"
node -e 'for (const f of ["locomo", "longmemeval-s"]) { const r = require("./packages/evals/reports/0.1.0/" + f + ".json"); console.log(r.dataset, r.setup.cases + " cases", r.setup.questions + " questions", "evidence recall@10 " + r.retrieval.evidenceRecallAtK, "answer accuracy " + r.answering.accuracy + " (n=" + r.answering.n + ")") }'
```

Expected:

```text
locomo 10 cases 1986 questions evidence recall@10 0.5718 answer accuracy 0.55 (n=20)
longmemeval-s 500 cases 500 questions evidence recall@10 0.9148 answer accuracy 0.9 (n=20)
```

Read it like this. Evidence recall is retrieval alone: on LoCoMo, ynm puts 57% of the evidence
in the top ten, on LongMemEval-S 91%. The full report breaks LoCoMo down by question category
(`temporal`, `single-hop`, `multi-hop`, `open-domain`, `adversarial`); the multi-hop and
open-domain categories, which need several memories at once, are the weak ones, near 24%.
Answer accuracy is measured on only twenty questions, so treat it as a smoke reading. The report also
records the dataset's sha256, its license, the writer and judge used and the ingest strategy, so a
number is never separated from how it was produced.

Compare these only with ynm's own earlier releases. Other systems report on different judges,
extraction-based ingest and answering models, so their scores are not the same measurement.

## Cleanup

Nothing to remove, apart from any datasets you downloaded into `~/.ynm/bench`, and the variable:

```bash
unset YNM_REPO
```

This is the last tutorial. To go on, see the [how-to guides](../how-to/README.md) for specific
jobs, or the [explanation](../explanation/README.md) pages for why ynm works the way it does.
