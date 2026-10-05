# Configure the judge and writer

Goal: choose which model does the judging in `ynm dream` and on recall, and which one writes
merged or reflective text. [Tutorial 8](../tutorial/08-dreaming.md) shows both at work, and
[Dreaming](../explanation/dreaming.md) explains why they are separate.

Two seams, kept apart on purpose. A **judge** answers typed questions (are these two memories the
same fact, does this one contradict that one) with probabilities; it never writes text. A
**writer** generates structured text (a merged memory, a reflection). Neither writes to the store:
ynm applies thresholds to their answers in code.

## What is chosen by default

With `judge` and `writer` both `auto`, ynm picks the first that is available:

1. **Judge.** `typesafe` if `TYPESAFE_API_KEY` is set; otherwise `writer-emulated` over whatever
   writer exists (uncalibrated); otherwise `heuristic`, the lexical no-model floor.
2. **Writer.** `claude-cli` if a `claude` CLI is on your PATH; otherwise `openai-compatible` if
   `OPENAI_API_KEY` or `YNM_OPENAI_BASE_URL` is set; otherwise `none`, and every pass that needs
   generation falls back to a non-generative path.

An uncalibrated judge, the heuristic and the writer-emulated one, can flag memories for review but
is never allowed to act. To see what was resolved, look at `full.judge` and `full.writer` in
`ynm dream --dry-run --json`.

Set `YNM_NO_CLAUDE_CLI=1` to stop ynm probing for the `claude` CLI, which pins you to the no-model
behaviour unless a key is set.

## Put keys in `~/.ynm/env`

Secrets belong in `<ynm home>/env` (`~/.ynm/env` by default), one `KEY=VALUE` per line, mode 600.
ynm loads it at start and never overrides a variable already in the environment. Do not put keys
in a repository or in `config.json`.

```text
TYPESAFE_API_KEY=...
```

## Configure in `config.json`

The `dream` block goes in `~/.ynm/config.json` (all projects) or `.ynm/config.json` (one
repository). Only set what you change.

### TypeSafe (Jev) as the judge

```json
{ "dream": { "judge": "typesafe", "typesafe": { "model": "jev-latest" } } }
```

Pin `model` to a version for reproducible numbers. `apiKeyEnv` (default `TYPESAFE_API_KEY`) names
the variable to read.

### The claude CLI as the writer

```json
{ "dream": { "writer": "claude-cli", "claude": { "model": "sonnet" } } }
```

It runs headless `claude -p` on your Claude Code login, so no key is needed. ynm removes
`ANTHROPIC_API_KEY` from the environment it gives the CLI, even when the key is in your shell,
`~/.ynm/env` or a repo `.env`: current Claude Code refuses to run when both a key and a login are
present. To run the CLI on the API key instead, opt in:

```json
{ "dream": { "writer": "claude-cli", "claude": { "useApiKey": true } } }
```

Only `ANTHROPIC_API_KEY` is removed; the rest of the environment is passed through.

### An OpenAI-compatible endpoint (Ollama, vLLM, a hosted API)

```json
{
  "dream": {
    "writer": "openai-compatible",
    "openai": { "baseUrl": "http://localhost:11434/v1", "model": "qwen3:latest" }
  }
}
```

The key is read from `OPENAI_API_KEY` (change the name with `openai.apiKeyEnv`); a local server
needs none. `YNM_OPENAI_BASE_URL` and `YNM_OPENAI_MODEL` override the two settings from the
environment.

### Force the heuristic

```json
{ "dream": { "judge": "heuristic", "writer": "none" } }
```

Free and deterministic. It finds candidates and flags them; it will not merge or retire anything.

## Thresholds and limits

Each pass has two thresholds and so three bands. At or above `act`, a calibrated judge lets ynm
act; an uncalibrated one only queues the memory for review. Between `review` and `act`, the
memory is flagged for review and nothing changes. Below `review`, it is ignored. Defaults are 0.85
and 0.6 for `dedupe` and `contradict`, 0.7 and 0.5 for `promote`:

```json
{ "dream": { "thresholds": { "dedupe": { "act": 0.9, "review": 0.7 } }, "maxPairsPerRun": 500 } }
```

`maxPairsPerRun` caps judged pairs (default 2000) and `ynm dream --max-pairs <n>` caps one run.
`judgeOnWrite` (default true) runs the judge when a memory is written; `rerank` (default true) uses
the judge to reorder the top `rerankTopK` recall hits.

## Cost

Calls are metered against a token budget, `YNM_TOKEN_BUDGET` (input tokens per process, default 2
million); crossing it stops the run instead of spending. When a provider's reply leaves out the
input-token count, the call is charged at ynm's own estimate of the request size. A pair
judgment is about 700 input tokens. Try `ynm dream --dry-run --max-pairs 20` first.
