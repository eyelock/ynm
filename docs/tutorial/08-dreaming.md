# Dreaming

Memory gets messy: the same fact is written twice, a newer decision contradicts an older one.
`ynm dream` is the maintenance run that notices. Without a model it can only flag; with one it
can merge and retire. This tutorial does both, and ends by promoting a private memory to the
team.

## Prerequisites

`ynm` is on your PATH. Prepare the sandbox, a personal store, and a repository with ynm
initialised in it (promotion needs a shared mount to promote into):

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
export YNM_NO_CLAUDE_CLI=1
cd /tmp/ynm-tutorial
ynm init --personal
echo '{"dream":{"judge":"heuristic"}}' > /tmp/ynm-tutorial/home/config.json
git init -q -b main project
cd project
git -c user.name=tutorial -c user.email=tutorial@example.com commit -q --allow-empty -m "first commit"
ynm init
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git`, then the `initialised`
report from tutorial 2 with the note that remote `origin` was not found.

Two things pin this tutorial to the no-model behaviour until the last section. If a `claude`
CLI is on your PATH, ynm will use it as a model on its own; `YNM_NO_CLAUDE_CLI=1` stops that.
And if a `TYPESAFE_API_KEY` is set, ynm picks the calibrated judge, which acts instead of
flagging; the config line pins the judge to `heuristic` regardless.

## Seed a mess

Two memories say the same thing in different words. Two share a subject and disagree. One is
fine:

```bash
ynm remember --type semantic --content "The API listens on port 8080." --tags api
ynm remember --type semantic --content "The API server listens on port 8080." --tags api
ynm remember --type semantic --content "We deploy on Tuesdays." --subject deploy-day
ynm remember --type semantic --content "We never deploy on Tuesdays; deploys are on Thursdays." --subject deploy-day
ynm remember --type semantic --content "The database is Postgres 14."
```

Expected: five `remembered <26-character id> in personal` lines.

## A dry run

`--dry-run` runs every pass and reports what would change, writing nothing:

```bash
ynm dream --dry-run
```

Expected: one line per pass, in the form `pass: changed/candidates`. The dedupe pass looked at
eight candidate pairs, the contradict pass at the one pair sharing a subject, and nothing would
change:

```text
expire: 0/0 would change
promote: 0/0 would change
dedupe: 0/8 would change
contradict: 0/1 would change
reflect: 0/0 would change
normalise: 0/0 would change
```

Nothing would change because there is no model. With no key and no `claude` CLI, ynm judges
with a heuristic: lexical similarity, recency and rules. Its answers are coarse and flagged
"uncalibrated", and an uncalibrated judge is never allowed to act. It can only raise a hand.
The JSON report shows that, under `full`:

```bash
ynm dream --dry-run --json
```

Expected: a JSON object with `"dryRun": true`. Under `full`, `judge` is
`{"name": "heuristic", "calibrated": false}` and `writer` is `"none"`. The `dedupe` pass lists
the two API memories under `flagged`, and the `contradict` pass lists the two deploy-day
memories, both with `"fallback": true`. Under `passes` every `changed` list is empty.

## Flag for real

Without `--dry-run` the same run writes its findings as review flags on the memories it
was unsure about. Still nothing is merged or deleted:

```bash
ynm dream
ynm review list
```

Expected: the same six pass lines with `changed` in place of `would change` and the same
counts (`0/8` and `0/1`), then a review queue of four memories, the two pairs, newest first:

```text
<id>  semantic   personal  We never deploy on Tuesdays; deploys are on Thursdays.
<id>  semantic   personal  We deploy on Tuesdays.
<id>  semantic   personal  The API server listens on port 8080.
<id>  semantic   personal  The API listens on port 8080.
```

The database memory is not there. It was compared and found unremarkable.

## Decide, and clear the flag

A human resolves the queue. Say the two API memories really are the same and you are content to
keep both for now; clear their flags. `review clear` takes a memory id, here picked out of the
queue by its content:

```bash
ynm review list | grep "API" | cut -d' ' -f1 | while read -r id; do ynm review clear "$id"; done
ynm review list
```

Expected: two `cleared review flag on <id>` lines, then a queue with only the two deploy-day
memories. The contradiction is still waiting for a decision.

## Promote to the team

Personal memory never reaches the shared store on its own. `promote` is the deliberate step: it
copies a personal memory into the project mount as a new memory, linked back to the original.
The Thursday rule is the one worth sharing:

```bash
THURSDAY=$(ynm review list | head -1 | cut -d' ' -f1)
ynm promote "$THURSDAY"
ynm list --level distributed
```

Expected: `promoted <id> -> <new id> in project`, then one distributed memory in the `common`
namespace:

```text
<new id>  semantic   distributed common                   We never deploy on Tuesdays; deploys are on Thursdays.
```

The copy has a new id and carries a `derives-from` link to the personal original, which stays
where it is. Promotion passes through the redaction gate from tutorial 2, so a memory with a
secret in it is refused here too.

## With a model: dedupe and contradict act

This part needs a decision model. ynm's default is TypeSafe's Jev, which needs the key in your
environment. Skip it if you do not have one; nothing later depends on it.

<!-- tutorial: skip unless TYPESAFE_API_KEY -->

```bash
echo '{"dream":{"judge":"auto"}}' > /tmp/ynm-tutorial/home/config.json
ynm dream --passes dedupe --passes contradict --max-pairs 10
```

The first line lifts the pin from the prerequisites: with `judge: auto` and the key set, the
calibrated judge is chosen.

Expected: with a calibrated judge the two passes are allowed to act. `dedupe` reports at least
one memory changed: of the two API duplicates, the older is tombstoned as
`duplicate of <newer id>` and the newer gains a `derives-from` link to it. `contradict` links the
two deploy-day memories with `contradicts`, and when the judge is confident the newer one
supersedes, the older ("We deploy on Tuesdays.") is tombstoned. Anything the judge is unsure
about lands in the review queue instead. `--max-pairs 10` caps how many pairs are judged, so the
run is small; the spend guard also stops a run that crosses its token budget.

<!-- tutorial: skip unless TYPESAFE_API_KEY -->

```bash
ynm list
ynm review list
```

Expected: `list` no longer shows both API memories or the Tuesday memory; the surviving
memories are the Thursday rule (personal and its promoted copy), one API memory and the
database memory. `review list` still shows the Thursday memory: the heuristic run flagged it
earlier and nothing has cleared that flag, so clear it now with `ynm review clear <id>` if you
like. Each judgment is stored on the memory it changed, with the questions asked, the
probabilities, the model and its version, so you can see why. Judges advise; the code applies
thresholds and does the writing.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER YNM_NO_CLAUDE_CLI THURSDAY
```

Next: tutorial 9, the wiki projection, where memory becomes a folder of Markdown you can edit.
