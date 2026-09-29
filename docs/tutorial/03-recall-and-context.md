# Recall and Context

Seed five memories, then shape what comes back: filter by type, tag, subject and time, ask why
a hit scored what it did, and control what an agent reads at the start of a session with the
context block and pins.

## Prerequisites

`ynm` is on your PATH. Prepare the sandbox and a personal store:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
cd /tmp/ynm-tutorial
ynm init --personal
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git` and nothing else.

## Seed five memories

Five memories, one of them each of four types, with subjects and tags. The subject is an
entity or topic key; two of the memories share `entity:staging`. Tags repeat the flag: a comma
is part of the tag, not a separator.

`--json` on the first command gives us its id, which we keep for later.

```bash
REF=$(ynm remember --type reference --content "The runbook for on-call lives at https://example.com/runbook." --tags oncall --json | grep '"memoryId"' | cut -d'"' -f4)
ynm remember --type semantic --content "Production deploys go through the release branch and need two approvals." --tags deploy --tags release --subject service:api
ynm remember --type episodic --content "Staging deploy failed on Monday because the migration lock was held." --tags deploy --tags incident --subject entity:staging
ynm remember --type episodic --content "Staging was rebuilt from scratch on Tuesday after the failed deploy." --tags deploy --subject entity:staging
ynm remember --type procedural --content "To roll back a release: run ynm-deploy rollback and confirm in the dashboard." --tags deploy --tags release
echo "reference id: $REF"
```

Expected: four `remembered <26-character id> in personal` lines, then the reference id.

## Recall with text

```bash
ynm recall --text "roll back"
```

Expected: one hit. The score is 0.875, a perfect relevance, a fresh memory and default
importance combined.

```text
0.875  <id>  procedural personal  To roll back a release: run ynm-deploy rollback and confirm in the dashboard.
```

## Ask why: explain

`--explain` adds the score components under each hit:

```bash
ynm recall --text "roll back" --explain
```

Expected: the same hit, then an indented line of three components on a 0 to 1 scale.

```text
0.875  <id>  procedural personal  To roll back a release: run ynm-deploy rollback and confirm in the dashboard.
        rel 1.00 rec 1.00 imp 0.50
```

`rel` is relevance to the text, `rec` is recency (it decays with age, per memory type), `imp` is
the memory's importance. The JSON form carries the weights that combine them:

```bash
ynm recall --text "roll back" --explain --json --limit 1
```

Expected: a JSON array of one object with an `explain` field. Its `weights` are
`relevance: 0.6`, `recency: 0.2`, `importance: 0.15` and `pinned: 0.05`; `total` is the score
you saw, 0.6 x 1 + 0.2 x 1 + 0.15 x 0.5 = 0.875.

## Filter by type

```bash
ynm recall --text "staging" --type episodic
```

Expected: the two staging incidents and nothing else. Scores are within a hair of 0.87 and the
order between them can vary.

```text
0.875  <id>  episodic   personal  Staging was rebuilt from scratch on Tuesday after the failed deploy.
0.871  <id>  episodic   personal  Staging deploy failed on Monday because the migration lock was held.
```

## Filter by tag

`--tags` requires every tag you give. Without `--text` there is nothing to match against, so
hits are ranked by recency and importance alone, and the score tops out at 0.725.

```bash
ynm recall --tags release
ynm recall --tags deploy --tags incident
```

Expected: the first command returns two memories, the semantic and the procedural, both scored
0.725. The second returns only the staging failure, the one memory with both tags.

## Filter by subject

A subject is an exact key:

```bash
ynm recall --subject entity:staging
```

Expected: the two episodic staging memories, each scored 0.725.

## Recall by time

`--since` (and `--until`) take an ISO timestamp or a bare date such as `2026-01-01` (midnight UTC), and work without any text. It is the
"what changed lately" query. `--limit` caps the count:

```bash
ynm recall --since 2026-01-01T00:00:00Z --limit 2
```

Expected: exactly two hits, both scored 0.725. A date without a time
(`2026-01-01`) is refused as an invalid ISO datetime.

## The context block

`ynm context` is what an agent reads at the start of a session. With no text it is ranked by
recency and importance:

```bash
ynm context
```

Expected: a `## Memory` heading, then five lines of the form `- (<type>) <summary> [<tags>]`,
one per memory. The five were written within a second of each other, so recency barely
separates them and their order can differ from run to run.

Give it a focus text and it ranks for that instead, and returns only what matches:

```bash
ynm context --text "staging" --budget-tokens 60
```

Expected: the two staging memories.

```text
## Memory
- (episodic) Staging was rebuilt from scratch on Tuesday after the failed deploy. [deploy]
- (episodic) Staging deploy failed on Monday because the migration lock was held. [deploy, incident]
```

`--budget-tokens` is an approximate cap. Squeeze it and lines are dropped from the bottom:

```bash
ynm context --budget-tokens 40
```

Expected: the heading and a single line. Which memory it is depends on how the near-tied
memories rank; it is not necessarily the runbook.

## Pin a memory

Under a tight budget the runbook may be cut. A pin says "always include this", and pinned
memories come first:

```bash
ynm pin "$REF"
ynm context --budget-tokens 40
```

Expected: `pinned <id>`, then a context block whose single line is the reference memory, marked
`(reference, pinned)`. It is there whatever the ranking says.

```text
## Memory
- (reference, pinned) The runbook for on-call lives at https://example.com/runbook. [oncall]
```

`recall` marks pinned hits with a `*`, and `--pinned-only` lists just them:

```bash
ynm recall --pinned-only
```

Expected: one line, the reference memory, with a `*` before the content.

```text
0.825  <id>  reference  personal  * The runbook for on-call lives at https://example.com/runbook.
```

Unpin it when it stops earning its place:

```bash
ynm pin "$REF" --unpin
ynm recall --pinned-only
```

Expected: `unpinned <id>`, then `no matches`.

## Annotate without changing content

`annotate` adds tags, importance and flags as a new record on the memory; the content is
untouched. Raise the importance of the runbook and give it a tag:

```bash
ynm annotate --memory-id "$REF" --importance 0.9 --tags favourite
ynm recall --text "runbook" --explain
ynm recall --tags favourite
```

Expected: `annotated <id> (record <26-character id>)`. The recall shows `imp 0.90` and a score of
0.935, up from 0.875. The tag query finds the runbook, so the new tag was added to the old
ones.

```text
0.935  <id>  reference  personal  The runbook for on-call lives at https://example.com/runbook.
        rel 1.00 rec 1.00 imp 0.90
```

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER REF
```

Next: tutorial 4, editing history, where memories are superseded, forgotten and purged.
