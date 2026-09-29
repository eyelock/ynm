# Running tutorials as evals

The tutorials are the acceptance tests for the CLI. Two layers check them.

## Layer 1: a model reads and runs the tutorial

This is the real check. A model is given a tutorial, a sandbox and the `ynm` on PATH, runs every
step in order, compares what it sees with each "Expected" block, and reports per step. It is
the same thing you do by hand, done by a model, so a tutorial that drifts from the CLI fails the
same way a broken CLI does.

From the repository, with the `claude` CLI installed (it spends tokens, so it is opt-in):

```bash
YNM_EVAL_CLAUDE_CLI=1 pnpm --filter @ynm/evals exec vitest run src/tier2/tutorials --reporter=verbose
```

Each tutorial records a `tutorial:<name>` baseline (steps matched over steps run). A step the
tutorial marks as skippable is reported as skipped, not failed.

To run one by hand in Claude Code or a ynh harness, paste this prompt, replacing the path:

```text
Read docs/tutorial/01-first-memory.md. Run every bash block in order, in this shell, exactly as
written; do not fix, skip or reorder anything unless the tutorial says a step may be skipped.
After each block compare what you see with the "Expected" block that follows it. Do not edit any
file. When you are done, list every step with: heading, ran (yes/no), matched (yes/no/skipped),
and for mismatches the observed output.
```

## Layer 2: mechanical smoke, free, on every push

A test extracts every bash block from every tutorial, runs them in order in the sandbox, and
fails on the first non-zero exit. It checks nothing about output; it exists so a renamed flag or
a broken command is caught before a model spends a token.

```bash
pnpm --filter @ynm/evals exec vitest run src/tier1/tutorials
```

## Writing a tutorial so both layers work

- Start with the sandbox block from the [tutorial index](README.md#the-sandbox).
- One bash block per step, pasteable verbatim, no placeholders.
- Follow it with an "Expected" block. Quote stable output literally; describe unstable parts
  ("a 26-character id", "today's date").
- Mark a step that needs a key or an optional tool with an HTML comment on the line before the
  fence: `<!-- tutorial: skip unless TYPESAFE_API_KEY -->`. Layer 2 skips it; layer 1 reports
  it as skipped when the condition is not met.
- End with a cleanup step.
