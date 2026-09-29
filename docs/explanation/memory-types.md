# The six memory types

Every memory ynm stores has a `type`, and the type is not a label: it decides how fast the
memory fades from recall, whether it expires, which consolidation passes may touch it, and what
it can turn into. This page explains each type the same way: what it is, why an agent needs
it, when to write and read it, what ynm does with it on its own, and how you set it.

The taxonomy is the one production agent-memory systems have converged on (working, episodic,
semantic, procedural, from the CoALA paper) plus two that nearly every product adds: reflective
and reference. [ADR-001](../adr/001-memory-model.md) records the decision.

## At a glance

| Type | Holds | Recency half-life | Expires | Written automatically by | Consolidation |
|---|---|---|---|---|---|
| `working` | scratch state for one session | 1 day | yes, TTL | agents mid-task | expire; promote into another type |
| `episodic` | what happened, when | 14 days | no | the promote pass (default target) | dedupe, contradict; feeds reflect |
| `semantic` | facts, decisions, preferences | 180 days | no | the promote pass | dedupe, contradict, normalise |
| `procedural` | how to do something | none | no | the promote pass | dedupe |
| `reflective` | what a series of episodes adds up to | 90 days | no | the reflect pass only | superseded when re-reflected |
| `reference` | where to find something | none | no | agents | dedupe |

"Recency half-life" is how the ranker treats age: a memory of that type loses half its recency
weight after that many days. `none` means age is ignored, so a two-year-old procedure ranks as
high as a new one. These half-lives are constants in the ranker today, not configuration.

## Working

**What it is.** Scratch state for the task in hand: the plan for this session, the three files
touched so far, the failing test being chased. The kind of thing you would write on a sticky
note and throw away at the end of the day.

**Why an agent needs it.** Context windows fill up and sessions get compacted. Working memory
survives a compaction and a restart of the same session without polluting long-term memory.

**When to write and read it.** Write it when a session has state worth surviving an
interruption. Read it at session start; `memory_session start` returns it in the context block.
Do not use it for anything that should still be true next week.

**What ynm does.** Working memory must live in a session namespace (`session/<id>`) and always
carries a TTL; `memory_session start` defaults it to eight hours. When the session ends, or the
dream `expire` pass runs, expired working memory is tombstoned. The `promote` pass looks at what
is left: a memory tagged `promote` is turned into an `episodic` memory (or the type you name)
without a model; otherwise a calibrated Judge decides whether it deserves to outlive the session.

**How you set it.** `--type working --namespace session/<id> --ttl PT2H` (ISO 8601 durations).
`ynm session start` creates the namespace and returns the id. Writing working memory outside a
session namespace is refused.

## Episodic

**What it is.** A record of something that happened: a deploy that failed and why, a review
comment, a decision meeting, a surprising test result. Dated, specific, past tense.

**Why an agent needs it.** Patterns live in episodes. Three deploys that slipped for the same
reason are a rule waiting to be written, but only if the three episodes were kept.

**When to write and read it.** Write it when something surprising or consequential happens,
especially failures and their causes. Give it a `subject` (`entity:staging`,
`topic:release-process`) so the series can be found again. Read it when the same subject comes
up: "what happened last time we touched the migration runner?"

**What ynm does.** Episodic memory fades fastest after working: half its recency weight is gone
in two weeks, because last month's incident matters less than yesterday's. It is the default
target when working memory is promoted. The `reflect` pass reads a subject's episodes (three or
more) and asks the Writer for a summary, which a Judge verifies against the episodes before it
is written as a `reflective` memory. `dedupe` and `contradict` also run over it.

**How you set it.** `--type episodic --subject topic:release --content "On 2026-08-04 release
1.2 slipped two days because the gate was skipped."` Put the date in the content; the
`normalise` pass rewrites relative dates ("last Tuesday") to absolute ones, but it is better not
to make it.

## Semantic

**What it is.** A fact that is true until it is not: the staging cluster is `blue-heron` in
`eu-west-2`; the team deploys on Tuesdays; the user prefers tabs; we decided against a
three-level privacy model and why.

**Why an agent needs it.** This is most of what "the agent remembers" means to people:
decisions, preferences, corrections, the shape of the world. Without it every session starts
from the code alone.

**When to write and read it.** Write it when a decision is made (and record the why), when the
user states a preference or corrects you, when a fact would change what you do next time. Read
it before answering questions about the project, the user or past decisions. Prefer
`memory_supersede` over a second memory when a fact changes.

**What ynm does.** Semantic memory fades slowly (half-life 180 days). It is the type most of the
consolidation work is about: `dedupe` merges paraphrases of the same fact, `contradict` flags
two memories that state different values for the same thing and, with a calibrated Judge,
tombstones the older one; `normalise` makes dates absolute. With a Judge configured, every write
is scored for importance and a memory that looks like a secret or sensitive personal data is
refused, the same way the redaction gate refuses a token.

**How you set it.** It is the default when a sentence states a fact: `--type semantic`. Add
`--importance 0.8` for something that should outrank its peers, `--valid-from` and `--valid-to`
when a fact has a known lifetime.

## Procedural

**What it is.** How to do something here: the order of steps, the flags, the command that
actually works, the check to run before pushing. A rule is a procedural memory in the
imperative.

**Why an agent needs it.** Procedures are the expensive discoveries. An agent that spent twenty
minutes finding the right invocation should not spend them again, and neither should its
colleague.

**When to write and read it.** Write it when a procedure took effort to discover. Write it as
one imperative paragraph, specific to this project. Read it before doing the thing: `ynm recall
--type procedural --text "release"`.

**What ynm does.** Procedural memory does not fade: age is ignored in ranking. It is what the
`promote` pass produces when repeated episodes describe the same situation, linked
`derives-from` the episodes. A distributed procedural memory is the closest thing ynm has to a
team rule, and the guidance agents receive tells them so.

**How you set it.** `--type procedural`. Promote a personal one to the team with
`ynm promote <id>`, which copies it into the shared store and links back; the original stays
personal.

## Reflective

**What it is.** What a series of episodes adds up to: "three of the last four releases slipped
when the gate was skipped." Derived, not observed.

**Why an agent needs it.** Episodes are too many to read and too specific to act on. A
reflection is the compressed, actionable form, and it is how a memory system notices patterns
instead of only recording events.

**When to write and read it.** You normally do not write it. It is produced by dreaming and read
like any other memory; it ranks well because it is recent and summarises several sources.

**What ynm does.** The `reflect` pass is the only producer. For each subject with at least
three episodes it asks the Writer for a summary that reports only facts, dates and outcomes the
episodes contain, then asks the Judge a battery of questions (unsupported claim? lost fact?
wrong date?) and withholds the draft if any fires. A written reflection links `derives-from` its
episodes; re-reflecting supersedes it. Half-life 90 days.

**How you set it.** Configure a Writer and a Judge (see the dream configuration in
`.ynm/config.json`) and run `ynm dream`, or let the hosted scheduler run it. You can write one
by hand with `--type reflective`, but then it carries no verification.

## Reference

**What it is.** A pointer: the dashboard URL, the ticket, the design doc, the file that holds
the config. Not the content, the location.

**Why an agent needs it.** Content goes stale and is often too big to store; the location
usually does not. A reference memory is how "where is the runbook?" gets answered without
storing the runbook.

**When to write and read it.** Write it when a document, ticket, dashboard or URL will be needed
again. Read it when looking for where something lives.

**What ynm does.** Reference memory does not fade. `dedupe` merges duplicates of the same
pointer; nothing else touches it.

**How you set it.** `--type reference --content "Grafana staging dashboard:
https://grafana.internal/d/staging" --tags dashboard`.

## Types, levels and namespaces together

Type says what kind of thing a memory is. Two other fields say who can see it and how it is
grouped:

- **Level** is `personal` (your store, never leaves your machine) or `distributed` (the
  project's shared refs, synced with the remote). Personal is the default for everything; make a
  memory distributed only when it is a team fact and contains no secret. The redaction gate
  refuses distributed writes that look like keys or tokens.
- **Namespace** groups memories: `user/<id>` for personal, `common` for distributed, anything
  hierarchical you like (`org/eyelock/project/ynm`), and `session/<id>` for working memory.

So "a personal procedural memory about project X" is `--type procedural --namespace
org/eyelock/project/x` at the default personal level, and promoting it to the team keeps the
type and namespace and changes the level.

## Which type do I pick?

The same list agents are given:

- A decision was made, and why: `semantic`, often distributed.
- The user stated a preference or corrected you: `semantic`, personal.
- A procedure that took effort to discover: `procedural`.
- Something surprising happened, including failures and their cause: `episodic`.
- A document, ticket, dashboard or URL that will be needed again: `reference`.
- State for this task only: `working`, in the session namespace.
- A summary of several episodes: leave it to dreaming; `reflective`.

Do not remember anything derivable from the code or git history, transient task state outside
working memory, secrets, or large pasted content.
