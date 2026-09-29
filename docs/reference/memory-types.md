# Memory types reference

The six values of `type`, the rules each one carries, and the ranker constants that depend on
it. The half-life and weight tables are generated from the ranker by `pnpm docs:gen`. For what
each type is for and when to use it, read [The six memory types](../explanation/memory-types.md);
[ADR-001](../adr/001-memory-model.md) records the decision.

## Types

| Type | Holds | Expires | Produced automatically by | Consolidation passes that touch it |
|---|---|---|---|---|
| `working` | scratch state for one session | yes, by `ttl` | agents mid-task | expire, promote, normalise |
| `episodic` | what happened, when | no | the promote pass (default target) | dedupe, contradict, normalise; read by reflect |
| `semantic` | facts, decisions, preferences | no | the promote pass | dedupe, contradict, normalise |
| `procedural` | how to do something | no | the promote pass | dedupe, contradict, normalise |
| `reflective` | what a series of episodes adds up to | no | the reflect pass only | superseded by a newer reflection; dedupe, contradict, normalise |
| `reference` | where to find something | no | agents | dedupe, contradict, normalise |

Contradict and reflect consider only memories with a `subject`. Dedupe compares a memory with
its nearest neighbours of the same type in the same mount.

## Rules per type

| Type | Rule | Enforced by |
|---|---|---|
| `working` | `namespace` must be `session/<id>` | the record schema; a write elsewhere is refused |
| `working` | expires `ttl` (an ISO 8601 duration) after its `updatedAt`. The write does not require or default a `ttl`; `ynm session start` reports a suggested one (`PT8H` unless `--ttl`), and a working memory written without one never expires | the expire pass, run by `ynm dream` and `ynm session end` |
| `working` | tagged `promote`: the promote pass turns it into an `episodic` memory without a judge and tombstones the original | the promote pass |
| `working` | untagged: promoted only when a calibrated judge scores it useful beyond the session at or above `dream.thresholds.promote.act`; the judge also picks `semantic`, `procedural` or `reference` as the target | the promote pass |
| `episodic` | three or more with the same `subject` (`dream.thresholds.reflect.minEpisodes`) are summarised into one `reflective` memory | the reflect pass, which needs a Writer |
| `reflective` | links `derives-from` each episode it summarises; written only when no verification question reaches `dream.thresholds.reflect.flagAt` | the reflect pass |

Every other field (`subject`, `tags`, `importance`, `validFrom`, `validTo`, `data`) is available
on every type. See the [record format](record-format.md).

## Ranker constants

Recency decays exponentially with a half-life per type: a memory `d` days old scores
`0.5^(d / half-life)` for recency; types without a half-life always score 1.

<!-- gen:half-lives -->
| Type | Recency half-life (days) |
|---|---|
| `working` | 1 |
| `episodic` | 14 |
| `semantic` | 180 |
| `procedural` | none (no decay) |
| `reflective` | 90 |
| `reference` | none (no decay) |
<!-- /gen:half-lives -->

The score is a weighted sum of relevance, recency, importance and pinned (1 or 0). The weights
depend on whether the query has `text`:

<!-- gen:weights -->
| Query | relevance | recency | importance | pinned |
|---|---|---|---|---|
| with `text` | 0.6 | 0.2 | 0.15 | 0.05 |
| filter only | 0 | 0.55 | 0.35 | 0.1 |
<!-- /gen:weights -->

Age is measured from the memory's `updatedAt`, so a supersede or annotate resets it. The weights
and half-lives are constants, not configuration. How they combine, and the reranker that can
follow, is explained in [How recall ranks](../explanation/how-recall-ranks.md).

## Levels and namespaces

| Level | Default namespace | Lives in | Synced by `ynm sync` |
|---|---|---|---|
| `personal` (default) | `user/<userId>` | the personal store, `~/.ynm/store.git` | only with `--mount personal` and an explicit `--remote` |
| `distributed` | `common` | the project repository's `shared` refs, or a configured mount | yes |
