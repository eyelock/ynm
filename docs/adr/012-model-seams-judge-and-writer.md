# ADR-012: Model seams: Judge (decision models) and Writer (generative, structured output)

Status: accepted (2026-09-29)
Satisfies: FR-12, FR-13, NFR-13, NFR-15

## Context

Structured data in and out of models is an essential requirement. Two different kinds of model now
exist and they should not share one interface:

- **Decision models** (TypeSafe's System One class; Jev is the first). They take JSON state and
  typed questions and return typed answers with calibrated probabilities: `Choice` (one of a set,
  with a distribution and confidence), `Noul` (probability that a condition holds), `Score`
  (probability-weighted position on 2 to 10 described levels). They do not generate text. Jev 1.13:
  64k tokens per request, 32k for state, about 100 ms per query, $0.042 per million input tokens,
  output free, 1,200 requests per minute. Independent questions over the same state run in one
  request. Sources: https://docs.typesafe.ai/concepts/system-one.md, https://docs.typesafe.ai/api.md,
  https://docs.typesafe.ai/models.md, https://docs.typesafe.ai/confidence.md.
- **Generative models** with structured output (tool-use or JSON-schema modes). They produce text
  or JSON, and the JSON must be validated by us.

Most of the memory lifecycle is judgment, not generation: is this a duplicate, do these contradict,
how important is this, is this still valid, does this candidate answer the query, does this summary
lose information. The documented cookbooks map onto those passes directly: entity alignment
(dedupe with a three-way route), reranking (Noul per query and candidate, BM25 shortlist reordered),
extraction cascade (a Noul battery verifies cheap output and escalates only flagged cases),
composite scoring (atomic Scores combined by weights in code, stored and recombined without
re-inference), citation check, guardrails.

## Decision

Replace the single `Reasoner` seam of ADR-006 with two seams, shipped in `@ynm/models`.

```ts
interface Judge {
  name: string;
  judge<Q extends Questions>(state: JsonValue, questions: Q): Promise<Answers<Q>>;
  limits(): { stateTokens: number; requestTokens: number; maxChoices: number };
}
// Questions and Answers mirror the three primitives: choice | noul | score, each with
// instructions and criteria; answers carry choice/noul/score plus probabilities and confidence.

interface Writer {
  name: string;
  write<T>(req: { instructions: JsonValue; state: JsonValue; schema: ZodType<T> }): Promise<T>;
  // structured output only: the result is validated against `schema`, retried once on failure,
  // then rejected. Free text is a schema with one string field.
}
```

Implementations:

| Seam | Implementation | Notes |
|---|---|---|
| Judge | `typesafe` | Built to the documented TypeSafe HTTP contract; `jev-latest` by default, pinned version in config; batches independent questions per request; respects the 32k state limit by pre-trimming state in code. Verified live against Jev 1.13: two rephrasings judged the same fact at 0.98 for 445 input tokens |
| Judge | `writer-emulated` | Asks a `Writer` for a JSON object of answers; probabilities are not calibrated and are flagged as such |
| Judge | `heuristic` | Lexical similarity, recency and rules only; question-id aware; returns coarse probabilities and an honest 0.5 for anything it does not know; the no-model fallback |
| Writer | `claude-cli` | Headless `claude -p` on the user's subscription; no key needed |
| Writer | `openai-compatible` | `json_schema` response format; covers Ollama and other local servers |
| Writer | `none` | Every pass that needs generation uses its non-generative fallback |

Every writer goes through one fail-closed loop: extract JSON, validate with Zod, retry once with
the issues, reject.

An `mcp-sampling` writer (borrowing the host client's model via pull-model delegation) is not
shipped. On SDK v2 sampling is a pull-model `InputRequiredResult` round trip, which needs the
multi-round plumbing the hosted server carries; the two local writers cover the evals.

**Every model interaction is typed.** Inputs are JSON state assembled by code. Outputs are typed
answers (Judge) or Zod-validated objects (Writer). No pass parses free text.

**Judgments are data.** Every Judge answer used to change a memory is stored: on the write path
in the record's own `data.judgments`, and in dream passes as an `annotate` record whose `data`
holds the questions asked, the answers, probabilities, confidence, model id and version. Rerank
judgments are not stored. Ranking weights and thresholds are then applied in code and can change
without re-inference, and the audit trail shows why a memory was merged, demoted or flagged.

**Confidence routing.** Each pass has three bands with thresholds in config, evaluated on real
data: act automatically; act and flag for review; do not act, queue for review. "Review" is an
`annotate` record with `needsReview: true`, surfaced by `memory_status`, the wiki, and a
`memory-dream-review` prompt. High-consequence actions (merge, tombstone, contradiction
resolution) start with conservative thresholds; low-consequence ones (rerank order, importance
nudges) start permissive. An **uncalibrated judge never reaches the act band**; the most it can
do is flag for review, which keeps the heuristic and emulated judges safe to run by default.
Explicit user signals (a `promote` tag) bypass the judge entirely.

### Where each seam applies

| Pass | Judge questions (typed, cheap) | Writer (generative) | No-model fallback |
|---|---|---|---|
| Dedupe (dream) | Score: different / related / same (entity-alignment shape) plus Nouls for same subject, same claim | Merge text for pairs judged "same" | Keep newest, link the rest |
| Contradiction (dream) | Noul: incompatible claims about the same subject; Noul: newer supersedes older | Resolution `supersede` text | `contradicts` link only, flag for review |
| Importance (write, optional; dream) | Score per type with described levels; composite in code | none | Writer-supplied default 0.5 |
| Promotion of working memory | Noul: useful beyond this session | none | Promote only if explicitly flagged |
| Staleness / validity | Noul: still true given newer memories; Noul: time-bound claim past its date | none | Recency decay only |
| Recall rerank | Noul per (query, candidate) over the index's top K (rerank cookbook) | none | Index score only |
| Reflect (dream) | Noul battery verifying the summary against its sources: unsupported claim, lost fact, wrong date (cascade shape); escalate or queue on any flag | Reflective summary | Skip pass |
| Redaction gate | Noul: contains secret, credential or personal data | none | Pattern list only |
| Classify raw input (optional ingest plug-in) | Choice: type; Choice: namespace from the known set | none | Caller must specify |

### Write path

Writes stay **generation-free** (ADR-006). When a Judge is configured (a TypeSafe key present is
enough), it runs on the write path by default, because a typed 100 ms judgment is a different
cost class from a generative call; a store can turn it off (`judge.onWrite: false`). On the write
path the judge scores importance (0..4 levels mapped to 0..1) only when the caller left the
default, flags near-duplicates, and refuses content it flags as sensitive at 0.9 or above, exactly
like a redaction hit. The judgments are stored in the record's `data.judgments`. With no Judge
available the write path is unchanged and the writer-supplied defaults apply.

## Alternatives considered

- One generative seam only, with Jev as an optional reranker. Rejected: it would leave dedupe,
  contradiction and verification as free-text prompts and lose calibrated probabilities.
- Using Jev for generation-shaped tasks (summaries). Not possible; it does not generate. The
  cascade pattern (cheap writer, Judge verifies, escalate) is the substitute.

## Consequences

- Credentials come from `TYPESAFE_API_KEY` or config. Secrets are loaded from `~/.ynm/env` or a
  gitignored repo-root `.env` without overriding the process environment, and a
  `.claude/settings.json` deny list stops the agent reading or printing them. Hosted services
  configure both a Judge and a Writer.
- Question definitions live in `@ynm/models` (`packages/models/src`) as typed constants with
  tests, next to the judges that answer them, so they are versioned with the record schema.
- Threshold values are config, not code, and ship with documented defaults plus a `ynm dream
  --dry-run` that reports what each pass would have done.
- Budget guard: passes batch pairs per request and cap pairs per dream run. At 1 KB per memory a
  10,000-pair dedupe is roughly 10M input tokens, under $0.50 at current Jev pricing.

## Open questions

None.

## History

- 2026-09-29 (M4): seams shipped in `@ynm/models` with three judges and three writers behind one
  fail-closed validation loop.
- 2026-09-29 (M4): an uncalibrated judge never reaches the act band; explicit user signals
  bypass it.
- 2026-09-29 (M4): the `mcp-sampling` writer deferred, pending the hosted server's multi-round
  plumbing.
- 2026-09-29 (M4): write-path judge shipped: importance only when defaulted, sensitive content
  refused at 0.9, judgments in `data.judgments`.
- 2026-09-29 (M4): secrets loaded from `~/.ynm/env` or a gitignored `.env`, denied to the agent.
- 2026-09-29: correction: the write-path judge switch is the config key `dream.judgeOnWrite` (not `judge.onWrite`), and there is no `memory-dream-review` prompt; memories flagged for review are listed by `ynm review`, and the wiki page frontmatter carries `needsReview`.
- 2026-10-05: the `claude-cli` writer removes `ANTHROPIC_API_KEY` from the child's environment by default, because current Claude Code exits 1 when a key and a login are both present; `dream.claude.useApiKey` keeps it.
