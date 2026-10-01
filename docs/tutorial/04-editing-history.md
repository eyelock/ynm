# Editing History

Memory is an append-only log, so "editing" means writing a new record. Supersede a fact, link
two memories, forget one, purge a secret for good, and move the whole log to another store
with export and import.

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

## Four memories

`--json` gives each id, which we keep in shell variables for the rest of the tutorial:

```bash
DEPLOY=$(ynm remember --type semantic --content "We deploy on Tuesdays." --tags deploy --json | grep '"memoryId"' | cut -d'"' -f4)
DB=$(ynm remember --type semantic --content "The staging database is Postgres 14." --json | grep '"memoryId"' | cut -d'"' -f4)
WIKI=$(ynm remember --type reference --content "Old wiki page: https://example.com/old-wiki" --json | grep '"memoryId"' | cut -d'"' -f4)
TOKEN=$(ynm remember --type semantic --content "Temporary API token is in the team notes: hunter2" --json | grep '"memoryId"' | cut -d'"' -f4)
echo "$DEPLOY $DB $WIKI $TOKEN"
```

Expected: four different 26-character ids on one line.

## Supersede: a new version of the same memory

The deploy day changed. `supersede` writes a new version under the same memory id:

```bash
ynm supersede --memory-id "$DEPLOY" --content "We deploy on Wednesdays, never on Fridays."
ynm recall --text "deploy"
```

Expected: `superseded <id> (record <26-character id>)`, where the id is the one you started with.
Recall returns one hit, the new wording. The old text is not lost; it is an earlier record in
the log, which we will see when we export.

```text
0.875  <id>  semantic   personal  We deploy on Wednesdays, never on Fridays.
```

## Link two memories

Links are typed pointers from one memory to another. The relations are `supersedes`,
`derives-from`, `contradicts`, `supports`, `about` and `in-session`. Record that the deploy
rule is about the staging database:

```bash
ynm annotate --memory-id "$DEPLOY" --links "[{\"rel\":\"about\",\"to\":\"$DB\"}]"
```

Expected: `annotated <id> (record <26-character id>)`. Content is unchanged; the annotation is a
record of its own.

## Forget: hide, but keep

`forget` writes a tombstone. The memory disappears from recall and list, but its history stays
in the log:

```bash
ynm forget --memory-id "$WIKI" --reason "wiki was retired"
ynm list
```

Expected: `forgot <id> (record <26-character id>)`, then three memories, without the wiki page.

```text
<id>  semantic   personal    user/tutorial            We deploy on Wednesdays, never on Fridays.
<id>  semantic   personal    user/tutorial            Temporary API token is in the team notes: hunter2
<id>  semantic   personal    user/tutorial            The staging database is Postgres 14.
```

Tombstoned memories are still there when you ask for them:

```bash
ynm recall --text "wiki"
ynm recall --text "wiki" --include-tombstoned
ynm list --include-tombstoned
```

Expected: the first prints `no matches`. The second finds `Old wiki page: ...`. The list shows
four memories, the forgotten wiki page first (its tombstone is the newest record). Nothing
marks it as forgotten in the list output; the flag only widens what is returned.

## Purge: remove for good

A token was pasted by mistake. Forgetting is not enough, because the text is still in the log.
`purge` physically removes the records, and asks you to confirm:

```bash
ynm purge "$TOKEN" --reason "secret pasted by mistake" || echo "exit $?"
```

Expected: an error that purge is irreversible, and exit code 2. Nothing was removed.

```text
 ›   Error: purge is irreversible; re-run with --yes to confirm
exit 2
```

```bash
ynm purge "$TOKEN" --reason "secret pasted by mistake" --yes
ynm recall --text "hunter2" --include-tombstoned
```

Expected: `purged <id>: 1 record(s) removed from personal`, then `no matches`. In place of the
memory the log keeps a `purge-marker` record with your reason, so an audit can see that
something was removed and why, but not what.

## Purge and history

Each shard is a git ref, and every write is a commit on it. Purging rewrites the records, but
earlier commits on the ref still hold the removed text. Count how many times it appears in the
shard's history:

```bash
git -C /tmp/ynm-tutorial/home/store.git log -p refs/notes/ynm/personal/user/tutorial/semantic/$(date -u +%Y-%m) | grep -o hunter2 | wc -l
```

Expected: a number greater than zero. The secret is gone from the log and still in git history.

`--forget-history` collapses the shard's ref history as well. Write a second secret and purge it
that way:

```bash
SECRET=$(ynm remember --type semantic --content "Password for the demo box is swordfish." --json | grep '"memoryId"' | cut -d'"' -f4)
ynm purge "$SECRET" --reason "second secret" --forget-history --yes
git -C /tmp/ynm-tutorial/home/store.git log -p refs/notes/ynm/personal/user/tutorial/semantic/$(date -u +%Y-%m) | grep -o -E "hunter2|swordfish" | wc -l
```

Expected: `purged <id>: 1 record(s) removed from personal`, then `0` (macOS pads the count with spaces). Neither secret survives in any
commit. Use it when the text really must not exist anywhere in this store; a store other people
have cloned still has their copies, so rotate the credential too.

## Export the log

`export` prints raw records as JSONL: one JSON record per line, every version, tombstones and
purge markers included. Write it to a file and count:

```bash
ynm export > /tmp/ynm-tutorial/backup.jsonl
wc -l < /tmp/ynm-tutorial/backup.jsonl
```

Expected: `8`, possibly padded with spaces. Three creates, the supersede, the annotate, the
tombstone, and two purge markers.

```bash
grep -o '"op":"[a-z-]*"' /tmp/ynm-tutorial/backup.jsonl | sort | uniq -c
```

Expected: `1 "op":"annotate"`, `3 "op":"create"`, `2 "op":"purge-marker"`,
`1 "op":"supersede"` and `1 "op":"tombstone"`, counts in that column layout.

## Import into a fresh store

A second home is a second personal store. Import the file there:

```bash
export YNM_HOME=/tmp/ynm-tutorial/home2
ynm init --personal
ynm import /tmp/ynm-tutorial/backup.jsonl
ynm list --include-tombstoned
```

Expected: `personal store created at /tmp/ynm-tutorial/home2/store.git`, `imported 8 record(s)`, and
the list shows three memories with the same ids as in the first store: the wiki page, the deploy
rule and the database fact. History came across with them; the purged secrets never
existed here.

```bash
ynm recall --text "deploy"
```

Expected: one hit with the Wednesday wording, under the id you saw earlier.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER DEPLOY DB WIKI TOKEN SECRET
```

Next: tutorial 5, sessions and working memory, where memories are given a lifetime.
