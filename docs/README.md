# ynm

**Your named memory.** Persistent memory for coding agents, stored as git notes in the
repositories you already have, served over MCP and a CLI with identical commands.

```bash
brew install eyelock/tap/ynm
cd your-repo && ynm init          # shared memory for this repo, and the agent clients it already uses
```

`ynm init` sets up the repository's shared memory (personal memory lives in `~/.ynm`) and
configures the agent clients this repository already uses: Claude Code, OpenCode and Pi get the
MCP server (for Pi, an extension) and the memory guidance, and Claude Code gets hooks that load
memory at session start and steer "remember this" into ynm. Clients found only on your machine,
such as Copilot CLI, get a one-line suggestion, and a ynh harness gets ynm with
`ynm client install ynh`. From then on the agent has
`memory_recall` and `memory_remember`, and you have the same thing as `ynm recall` and
`ynm remember`. Personal memory never leaves your machine; shared memory travels with
`git push`.

## What is here

This documentation follows [Diátaxis](https://diataxis.fr): four kinds of page, each with one
job.

| | |
|---|---|
| [Tutorials](tutorial/README.md) | Ordered lessons. Each is a script you run, with the expected output of every step. They double as the acceptance tests for the CLI: a model reads them, runs them, and checks. |
| [How-to guides](how-to/README.md) | Recipes for a goal you already have: run a hosted store, rotate keys, cut a release. |
| [Explanation](explanation/README.md) | Why things are the way they are, starting with the six memory types. |
| [Reference](reference/README.md) | The facts: commands, tools, config keys, record format. |

## The shape of it

- Six memory **types**: working, episodic, semantic, procedural, reflective, reference.
- Two **levels**: personal (your own store, `~/.ynm/store.git`) and distributed (the project's
  `refs/notes/ynm/distributed/*`, synced with its remote). A redaction gate sits in front of every
  distributed write.
- Unbounded **namespaces** (`common`, `user/<id>`, `org/<org>/project/<name>`, `session/<id>`).
- Recall is indexed (SQLite FTS) and ranked by relevance, recency per type, importance and pins.
- Dreaming consolidates: expire, promote, dedupe, contradict, reflect, normalise. Decisions come
  from a pluggable Judge (TypeSafe Jev when a key is present) and writing from a pluggable Writer.
- One binary: `ynm serve` is the MCP server over stdio, `ynm serve --http` the hosted service.
