# Sessions and Working Memory

Give an agent a scratchpad that cleans itself up. Start a session, write working memory with a
time to live, watch it expire, and let a tagged note graduate into long-term memory.

## Prerequisites

`ynm` is on your PATH. Prepare the sandbox and a personal store with one long-term memory:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
export YNM_NO_CLAUDE_CLI=1
cd /tmp/ynm-tutorial
ynm init --personal
ynm remember --type semantic --content "Releases are cut from the main branch."
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git`, then
`remembered <26-character id> in personal`.

`YNM_NO_CLAUDE_CLI=1` stops ynm from using a `claude` CLI on your PATH as a model for the
consolidation passes below, so the output is the same on every machine. Tutorial 8 covers models.

## Start a session

A session is an id and a namespace, `session/<id>`, that working memory lives in. Starting one
also prints the context block, so an agent starts with the memory it needs:

```bash
ynm session start | tee /tmp/ynm-tutorial/session.txt
```

Expected: three parts. A `session <id>` line with a 26-character lowercase id, a line naming the
working namespace and its default time to live, and the context block.

```text
session <26-character id>
working namespace session/<same id> (ttl PT8H)

## Memory
- (semantic) Releases are cut from the main branch.
```

`PT8H` is an ISO 8601 duration: eight hours. Keep the id:

```bash
SID=$(head -1 /tmp/ynm-tutorial/session.txt | cut -d' ' -f2)
echo "$SID"
```

Expected: the same 26-character id.

## Write working memory

Working memory is the one memory type that needs a session namespace and always carries a TTL (eight hours if you give none). Write two
notes: a throwaway that lives one second, and a decision tagged `promote` that lives the
default eight hours:

```bash
ynm remember --type working --namespace "session/$SID" --ttl PT1S --content "Trying the migration on staging first."
ynm remember --type working --namespace "session/$SID" --ttl PT8H --tags promote --content "Decision: ship the migration behind a flag."
```

Expected: two `remembered <id> in personal` lines.

## The namespace rule

Working memory outside a session namespace is refused, whether or not you give a TTL:

```bash
ynm remember --type working --ttl PT1S --content "Where does this go?" || echo "exit $?"
```

Expected: an error naming the `namespace` field and the rule, and exit code 2. The message
is a JSON list of issues, the relevant one being:

```text
"message": "working memory must live in session/<id>"
exit 2
```

## Let the first note expire

```bash
sleep 2
ynm list
```

Expected: three memories, both working notes still listed. Expiry is not clock magic: a
memory past its TTL stays in the store until something expires it.

## Dry-run the consolidation

`dream` runs the maintenance passes. `--dry-run` reports what each would change and changes
nothing:

```bash
ynm dream --dry-run
```

Expected: one line per pass. Two of them would act: `expire` on the one-second note and
`promote` on the tagged decision. `retention`, part of the expire pass, retires old occurrence
records and has none to look at here. Counts read `changed/candidates`.

```text
expire: 1/2 would change
retention: 0/0 would change
promote: 1/2 would change
dedupe: 0/0 would change
contradict: 0/0 would change
reflect: 0/0 would change
normalise: 0/0 would change
```

## End the session

Ending a session expires its working memory that is past its TTL and reports how many:

```bash
ynm session end "$SID"
ynm list
```

Expected: `ended <id>; expired 1 working memory`. The list now has two memories: the tagged
decision, still `working`, and the semantic one. The decision has eight hours to live, so it
was not expired.

## Promote a working note

The `promote` pass turns working memory tagged `promote` into an episodic memory in your own
namespace, and retires the working copy:

```bash
ynm dream
ynm list
```

Expected: the pass lines now read `expire: 0/1 changed` and `promote: 1/1 changed`. The list
has two memories again, but the decision is now `episodic` in `user/tutorial`, with a new id,
and it no longer lives in a session namespace:

```text
<id>  episodic   personal    user/tutorial            Decision: ship the migration behind a flag.
<id>  semantic   personal    user/tutorial            Releases are cut from the main branch.
```

The working copies are tombstoned, not deleted:

```bash
ynm list --include-tombstoned
```

Expected: four memories, adding both working notes under `session/<id>`.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER YNM_NO_CLAUDE_CLI SID
```

Next: tutorial 6, sync, where two clones share a project's memory through a remote.
