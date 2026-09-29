# ADR-012: Model seams: Judge (decision models) and Writer (generative, structured output)

Status: draft
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

## Decision (current position)

Replace the single `Reasoner` seam of ADR-006 with two seams.

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
| Judge | `typesafe` | `@typesafe-ai/sdk`, `jev-latest` by default, pinned version in config; batches independent questions per request; respects the 32k state limit by pre-trimming state in code |
| Judge | `writer-emulated` | Asks a `Writer` for a JSON object of answers; probabilities are not calibrated and are flagged as such |
| Judge | `heuristic` | Lexical similarity, recency and rules only; returns coarse probabilities; the no-model fallback |
| Writer | `mcp-sampling` | Borrow the host client's model via pull-model delegation; structured output via instructions plus Zod validation |
| Writer | `anthropic`, `openai-compatible` | Native structured output (tool-use or JSON schema); `openai-compatible` covers local servers |
| Writer | `none` | Every pass that needs generation uses its non-generative fallback |

**Every model interaction is typed.** Inputs are JSON state assembled by code. Outputs are typed
answers (Judge) or Zod-validated objects (Writer). No pass parses free text.

**Judgments are data.** Every Judge answer used to change a memory is stored as an `annotate`
record whose `data` holds the questions asked, the answers, probabilities, confidence, model id
and version. Ranking weights and thresholds are then applied in code and can change without
re-inference, and the audit trail shows why a memory was merged, demoted or flagged.

**Confidence routing.** Each pass has three bands with thresholds in config, evaluated on real
data: act automatically; act and flag for review; do not act, queue for review. "Review" is an
`annotate` record with `needsReview: true`, surfaced by `memory_status`, the wiki, and a
`memory-dream-review` prompt. High-consequence actions (merge, tombstone, contradiction
resolution) start with conservative thresholds; low-consequence ones (rerank order, importance
nudges) start permissive.

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
enough), it runs on the write path **by default** for importance, near-duplicate flagging and the
redaction gate, because a typed 100 ms judgment is a different cost class from a generative call.
A store can turn it off (`judge.onWrite: false`). With no Judge available the write path is
unchanged and the writer-supplied defaults apply.

## Alternatives considered

- One generative seam only, with Jev as an optional reranker. Rejected: it would leave dedupe,
  contradiction and verification as free-text prompts and lose calibrated probabilities.
- Using Jev for generation-shaped tasks (summaries). Not possible; it does not generate. The
  cascade pattern (cheap writer, Judge verifies, escalate) is the substitute.

## Consequences

- `@typesafe-ai/sdk` becomes an optional dependency of the service package; credentials via
  `TYPESAFE_API_KEY` or config. Hosted services configure both a Judge and a Writer.
- Question definitions live in `packages/model/src/judgments/*.ts` as typed constants with tests,
  next to the Zod schemas, so they are versioned with the record schema.
- Threshold values are config, not code, and ship with documented defaults plus a `ynm dream
  --dry-run` that reports what each pass would have done.
- Budget guard: passes batch pairs per request and cap pairs per dream run. At 1 KB per memory a
  10,000-pair dedupe is roughly 10M input tokens, under $0.50 at current Jev pricing.

## Decided

- Judge on the write path is on by default whenever a key is present, off per store by config
  (2026-09-28).
- Rerank judgments are not stored; only dream-pass and write-path judgments that change a
  memory are (default, 2026-09-28).

## Open questions

- None outstanding.

## Addenda

Dated notes added while building. Anything here that changes the Decision above is folded into
it at consolidation time.

- 2026-09-29 (M4): seams shipped in `@ynm/models`. Judges: `typesafe` (built to the documented
  HTTP contract, verified live against Jev 1.13: two rephrasings judged the same fact at 0.98 for
  445 input tokens), `heuristic` (question-id aware, honest 0.5 for anything it does not know),
  `writer-emulated` (uncalibrated). Writers: `claude-cli` (headless `claude -p` on the user's
  subscription, no key), `openai-compatible` (Ollama and friends, json_schema response format),
  `none`. Every writer goes through one fail-closed loop: extract JSON, validate with Zod, retry
  once with the issues, reject.
- 2026-09-29 (M4): policy added: an **uncalibrated judge never reaches the act band**; the most it
  can do is flag for review. Explicit user signals (a `promote` tag) bypass the judge entirely.
  This keeps heuristic and emulated judges safe to run by default.
- 2026-09-29 (M4): the `mcp-sampling` writer is deferred to M5. On SDK v2 sampling is a pull-model
  `InputRequiredResult` round trip, which needs the multi-round plumbing the hosted server will
  carry anyway; the two local writers cover the M4 evals.
- 2026-09-29 (M4): write-path judge as decided: importance scored (0..4 levels mapped to 0..1) only
  when the caller left the default, and content the judge flags as sensitive at 0.9 or above is
  refused like a redaction hit. Judgments are stored in the record's `data.judgments`.
- 2026-09-29 (M4): secrets come from `~/.ynm/env` or a gitignored repo-root `.env`, loaded without
  overriding the process environment; a `.claude/settings.json` deny list stops the agent reading
  or printing them.
