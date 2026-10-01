# How recall ranks

When an agent asks ynm for memory, the answer is a short ranked list, and the order matters more
than the length: the agent reads the top few and stops. This page explains how that order is
decided: the index that finds candidates, the score that orders them, why age counts differently
for each type, what pinning does, and the optional reranker at the end.

## Why there is an index at all

Memory lives in git notes, and reading git on every query is far too slow for a tool an agent
calls several times a turn. So each store has a derived index beside it: a SQLite file with a
full-text table and a metadata table. It is never shared and never the truth. Before answering,
ynm compares the revisions of the store's shards with the ones the index last saw; if anything
moved, because another clone synced or another process wrote, that mount's index is rebuilt from
the log. Writes made by the same process are applied to the index directly, so what you just
remembered is recallable at once.

## Finding candidates

A query with `text` is a full-text search. The words are matched with stemming (so "deploys"
finds "deployed"), any matching word counts, and SQLite's BM25 orders the matches. Matches in the
summary weigh twice as much as matches in the content, and the subject counts one and a half
times. Filters (type, level, namespace prefix, subject, tags, data key, time range, pinned only)
narrow the same query rather than running after it.

Each mount returns up to four times the requested limit, at least forty, and its best match is
given relevance 1, the rest scaled below it. A query with no `text` skips full-text search: every
memory that passes the filters is a candidate, and relevance plays no part.

## The score

Each candidate gets one number, a weighted sum of four parts:

- **relevance**: how well it matched the text, 0 to 1;
- **recency**: how recently it changed, 0 to 1, decaying by type;
- **importance**: the memory's own 0 to 1 value, 0.5 unless someone set it;
- **pinned**: 1 if pinned, else 0.

With text, relevance carries most of the weight (0.6), then recency (0.2), importance (0.15) and
pinned (0.05). Without text there is nothing to be relevant to, so recency (0.55) and importance
(0.35) carry the ranking and pinned rises to 0.1. The weights are constants, tuned against the
retrieval evals; the [memory types reference](../reference/memory-types.md) lists them.

Asking for `--explain` returns each part and the weights, so you can see why a memory ranked
where it did:

```bash
ynm recall --text "how do we release" --explain
```

## Why age depends on type

Recency is not one clock. Each type has a half-life: the number of days after which a memory has
lost half its recency score. Working memory halves in a day, episodic in two weeks, reflective
in three months, semantic in six. Procedural and reference memory do not decay at all.

The reason is what each type is. Yesterday's incident matters more than last quarter's, so
episodes fade quickly. A fact stays true until it is superseded, so it fades slowly. A procedure
that worked two years ago is exactly as useful today, and a pointer to the runbook does not get
worse with age, so for those two, age is ignored. Age is measured from the last change, so
superseding or annotating a memory makes it recent again.

## Pinning

A pinned memory gets the pinned part of the score, which nudges it up in recall. Its real effect
is on the context block: `memory_context` takes every pinned memory first, then fills the rest
of its token budget with the best-ranked ones. That is the always-in-context tier, for the few
things an agent should never start without. Pin sparingly; everything pinned spends budget in
every session.

## The reranker

The weighted score is cheap and predictable, but it only knows about words. When a calibrated
Judge is configured and the query has text, a final stage asks it, for each of the top candidates
(fifteen by default), how likely the memory is to help with the query. The answer is a
probability, blended 0.7 with the judge and 0.3 with the prior score, and the list is re-sorted.
It catches the memory that uses none of the query's words but answers it anyway.

The reranker is skipped without a calibrated judge, for queries without text, when `dream.rerank`
is off, or when a query passes `rerank: false`. If a judgment fails, that candidate keeps its
prior score. Rerank judgments are not stored; they are about one query, not about the memory.

## What never ranks

Tombstoned memories are left out unless you ask for them. Memories in other mounts are included,
ranked on the same scale and labelled with their mount, so a personal preference and a team
decision can sit next to each other in one answer.
