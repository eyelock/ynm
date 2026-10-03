# Dreaming

Writing a memory is fast and dumb on purpose: ynm stores what the agent gives it. Tidying up
happens later, in a separate step called dreaming, which merges duplicates, notices
contradictions, turns episodes into lessons and throws away scratch state. This page explains the
passes, how a model's confidence decides what happens, and why the models that judge are kept
apart from the models that write.

## Why not tidy on write

Some memory systems run a model on every write to extract, merge and classify. That puts a model
call, its cost and its latency, in the path of every tool call an agent makes, and it second-
guesses an agent that usually knows what it meant to remember. ynm's write path never generates
text. It does two cheap things: it tells the agent when similar memories already exist, so the
agent can supersede instead of duplicating, and, when a calibrated Judge is available, it scores
importance and refuses content that looks sensitive. Everything else waits for a dream.

Dreaming only ever appends records: a `supersede`, an `annotate`, a `tombstone`. It never edits
or deletes a line, so it is safe to run on any clone, its results merge with everyone else's,
and every change it makes can be traced and undone.

## The six passes

A dream runs these in order over one namespace, or over everything:

1. **Expire.** Working memory whose TTL has passed is tombstoned. No model.
2. **Promote.** Working memory that should outlive its session becomes a lasting memory, linked
   back to the original, which is then tombstoned. A memory tagged `promote` goes straight to
   `episodic` without a model; otherwise the Judge decides whether it is worth keeping and what
   type it should become.
3. **Dedupe.** Each memory is compared with its nearest neighbours of the same type from the
   index, and the Judge scores whether each pair states the same fact. For a duplicate, the newer
   memory survives; with a Writer, its text is rewritten to merge both; the older one is linked
   and tombstoned.
4. **Contradict.** Memories that share a subject are compared for incompatible claims. Both get a
   `contradicts` link. The older is tombstoned only if the Judge is also confident the newer one
   replaces it; otherwise both are flagged for a person to decide.
5. **Reflect.** For a subject with three or more episodes, the Writer drafts a summary of what
   they add up to, reporting only what the episodes say. The Judge then checks the draft for
   unsupported claims, lost facts and wrong dates. Any doubt withholds it. A written reflection
   links to its episodes and replaces the previous reflection on that subject.
6. **Normalise.** Relative dates ("yesterday", "3 days ago") are rewritten as absolute ones,
   counted from when the memory was recorded. No model.

Candidate pairs come from the index and are capped per run, so a dream over a large store costs
a bounded number of judgments.

## Only what changed

A dream judges only what is new. When a full run has finished with a memory, it marks the memory
with the version it judged: its current content, its subject and the judge that looked. The next
run treats a memory as fresh only if it is new, its content or subject has changed, or a
different judge is now configured. Tags, links, review flags and dream's own annotations do not
count as changes.

- **Nothing fresh, nothing judged.** If no memory is fresh, the run expires due working memory
  and stops: no searches, no model calls. A scheduled dream on a quiet store costs nothing but
  the run itself. A working memory tagged `promote` is still promoted, since that needs no model.
- **Pairs are judged once.** Dedupe and contradict only judge a pair with at least one fresh
  side, so two memories already compared are not compared again. Adding one memory to a large
  store costs that memory's pairs, not the whole store's.
- **Switching judges looks again.** Each memory is judged afresh once by a new judge, for
  example when you add a key so a calibrated model replaces the heuristic.
- **A capped run catches up.** When the pair cap stops a run early, the memories it did not
  finish stay fresh and the next run carries on from them. Every pass works through fresh
  memories in the same order, newest first, so each run finishes some and the backlog shrinks.
  A pair is judged at the turn of whichever memory comes first, so the newest memories, the
  likeliest to repeat an older one, are compared with the rest before the cap runs out.

The mark is an ordinary `annotate` record, so it syncs like any other and every clone and every
instance of a hosted store agrees on what has been dreamed. It does not change `updatedAt`, so
it neither extends a working memory's TTL nor moves a memory up a newest-first list. Only a full
run marks: a run limited with `--passes` or `--namespace` judges only fresh memories but leaves
them fresh, because it has not run every pass over them.

## Bands: act, review, ignore

Every judgment is a probability, and each pass has two thresholds that split it into three
bands. At or above **act**, the pass makes the change. Between **review** and act, it flags the
memories for review instead (`needsReview`), for a person to look at with `ynm review list`.
Below review, it does nothing. Merges and tombstones start with conservative thresholds; the
thresholds are configuration, so a team can tune them on its own data.

One rule overrides the thresholds: **an uncalibrated judge never acts.** The heuristic judge
and a judge emulated by asking a generative model both produce numbers that look like
probabilities but are not calibrated, so whatever they say, the most they can do is flag. That
is what makes it safe to run a dream with no model and no key at all: it will expire and
normalise, and it will point at likely duplicates, but it will not merge or delete anything on a
guess. An explicit signal from you, the `promote` tag, bypasses the judge entirely.

To see what a dream would do without changing anything:

```bash
ynm dream --dry-run
```

## Judges and writers are different things

ynm uses two kinds of model and keeps them behind two separate seams.

A **Judge** answers typed questions about structured input: is this the same fact, do these
contradict, is this sensitive, does this summary claim something its sources do not. It returns
probabilities, not prose. A calibrated decision model does this cheaply and fast, and its numbers
mean what they say.

A **Writer** generates: merged text for a duplicate, a reflection over a series of episodes. Its
output is structured and validated against a schema, retried once, and rejected if it still does
not fit.

The reason they are separate is that most of memory maintenance is judgment, not writing, and
the two fail differently. A generative model asked "are these the same?" answers fluently and is
confidently wrong often enough to matter; a model asked to write a summary will write one whether
or not it is faithful. So writers never decide, and nothing a writer produces is kept without a
judge checking it first. Reflection is the clearest case: the Writer drafts, the Judge verifies
against the sources, and doubt withholds the draft.

Each pass says what it does when a model is missing. Without a Writer, dedupe links instead of
merging text and reflect is skipped. Without a calibrated Judge, nothing is acted on that needs
one, and the report says the pass fell back.

## Judgments are kept

Every judgment that led to a change is stored on the memory as annotate data: the questions
asked, the answers and probabilities, the model and when. So the trail shows why a memory was
merged, flagged or retired, and if the thresholds change later the old judgments can be weighed
again without asking the model twice.

## When dreams happen

You can run `ynm dream` yourself, or an agent can call `memory_consolidate`. Ending a session
runs the expire pass for that session. A hosted store runs dreams on a schedule. The dream report
lists, per pass, what was considered, judged, changed, flagged and skipped, the tokens used and
an estimated cost, and how many memories were fresh and how many the run marked as finished.
