# Exit codes and JSON output

What `ynm` returns to a script: the exit code, where errors go, and the shape `--json` prints
for the common commands. Captured from the CLI; ids, hashes, paths and times vary.

## Exit codes

| Code | Meaning | Examples |
|---|---|---|
| `0` | Success | Also: `recall` with no matches, `doctor` with only warnings |
| `1` | The command ran and failed | `sync` reported a conflict; `doctor` found an error-level check failing; an unknown memory id; git or store errors |
| `2` | The command refused its input | a missing required flag or argument; a value outside a flag's options; an unknown command; input the schema rejects or a malformed JSON flag value (`invalid input: ...`); the redaction gate (`refused: ...`); `purge` without `--yes`; `session end`, `review clear` or `wiki ingest` without their id or file; syncing the personal mount without `--remote` |

Errors are printed on stderr, prefixed `Error:`. Output on stdout is only ever the result.

## JSON output

Every command except `serve` takes `--json` and then prints one JSON document on stdout,
indented by two spaces. `export` prints JSONL whether or not `--json` is given. Human output is
not a stable interface; use `--json` in scripts.

### Write results

`remember`, `supersede`, `annotate`, `forget`, `pin` and `promote` print the record they wrote:

```json
{
  "memoryId": "01M3PQB61JZYP3EYCG1ETP7Y7T",
  "recordId": "01M3PQB7BMKJGQQJHJFGVB7CKS",
  "mount": "personal",
  "revision": "18444438ecbe46b27f4d7e8fa4708831aa0b69e1"
}
```

`recordId` equals `memoryId` for a `remember` and for the new memory `promote` creates.
`revision` is the store's revision after the write (for `git-notes`, the shard ref's new commit).

### recall

An array of hits, best first. `explain` is present only with `--explain`; `subject` only when
set. `data`, `dataSchema` and `source` are present when the memory has them: `data` is its
structured payload as written, `dataSchema` the name of that payload's shape, and `source` the
source reference it was written with. `content` also ends with data's string values, so a text
search finds them. `author` is present when a signed-in person last wrote the memory on a hosted
store.

```json
[
  {
    "memoryId": "01M3PQB61JZYP3EYCG1ETP7Y7T",
    "mount": "personal",
    "score": 0.875,
    "explain": {
      "relevance": 1,
      "recency": 1,
      "importance": 0.5,
      "pinned": 0,
      "total": 0.875,
      "weights": { "relevance": 0.6, "recency": 0.2, "importance": 0.15, "pinned": 0.05 }
    },
    "type": "semantic",
    "level": "personal",
    "namespace": "user/docs",
    "tags": ["deploy"],
    "summary": "The team deploys on Tuesdays",
    "content": "The team deploys on Tuesdays",
    "pinned": false,
    "importance": 0.5,
    "updatedAt": "2026-09-29T13:58:22.002Z"
  },
  {
    "memoryId": "01M3PQB7K2V9X4D8RZ6N0CFJ1A",
    "mount": "personal",
    "score": 0.6,
    "type": "episodic",
    "level": "personal",
    "namespace": "user/docs",
    "tags": ["ci"],
    "summary": "Build failed on the release lane",
    "content": "Build failed on the release lane\ntimeout in step 3 release",
    "pinned": false,
    "importance": 0.5,
    "updatedAt": "2026-09-29T14:02:10.415Z",
    "data": { "signature": "timeout in step 3", "count": 2, "lane": "release" },
    "dataSchema": "ci.failure.v1",
    "source": "run:42"
  }
]
```

No matches is `[]` with exit code 0.

### list

An array of folded memories, newest first. `current` is the record that holds the current
content, in the [record format](record-format.md).

```json
[
  {
    "memoryId": "01M3PQB61JZYP3EYCG1ETP7Y7T",
    "current": { "v": 1, "id": "01M3PQB61JZYP3EYCG1ETP7Y7T", "op": "create", "...": "..." },
    "type": "semantic",
    "level": "personal",
    "namespace": "user/docs",
    "tags": ["deploy"],
    "links": [],
    "importance": 0.5,
    "confidence": 1,
    "pinned": false,
    "needsReview": false,
    "tombstoned": false,
    "createdAt": "2026-09-29T13:58:22.002Z",
    "updatedAt": "2026-09-29T13:58:22.002Z",
    "versions": 1,
    "mount": "personal"
  }
]
```

`review list` prints the same shape, limited to memories with `needsReview`.

### context

```json
{
  "markdown": "## Memory\n- (semantic) The team deploys on Tuesdays [deploy]\n",
  "included": ["01M3PQB61JZYP3EYCG1ETP7Y7T"],
  "tokens": 16,
  "truncated": false
}
```

When nothing is stored, `markdown` is empty and `included` is `[]`; without `--json`,
`ynm context` prints `no memory yet`. When there is memory but none of it fits `--budget-tokens`,
`markdown` is empty too, `truncated` is `true`, and the human output says so. Over MCP,
`memory_context` returns the same empty `markdown` with guidance that points the agent at
`memory_remember` and `memory_recall`.

### session

`session start`:

```json
{
  "sessionId": "01m3pqb8nhjrpr56ppbvvxk2n8",
  "namespace": "session/01m3pqb8nhjrpr56ppbvvxk2n8",
  "ttl": "PT8H",
  "context": { "markdown": "", "included": [], "tokens": 0, "truncated": false }
}
```

This one started on an empty store, so its `context.markdown` is empty; the human output shows
`no memory yet` in place of the context block.

`session end <id>`: `{ "sessionId": "...", "expired": ["<memoryId>", ...] }`.

### dream

`passes` summarises each pass; `full` is the complete report.

```json
{
  "dryRun": true,
  "passes": { "expire": { "candidates": 0, "changed": [] }, "...": {} },
  "full": {
    "dryRun": true,
    "judge": { "name": "heuristic", "calibrated": false },
    "writer": "none",
    "passes": {
      "expire": {
        "candidates": 0,
        "judged": 0,
        "changed": [],
        "flagged": [],
        "skipped": 0,
        "fallback": false,
        "usage": { "inputTokens": 0, "outputTokens": 0 },
        "notes": []
      }
    },
    "fresh": 5,
    "dreamed": 0,
    "usage": { "inputTokens": 0, "outputTokens": 0 },
    "estimatedCostUsd": 0
  }
}
```

`fresh` counts the memories new or changed since a run with this judge last finished with them;
`dreamed` counts the ones this run finished with and marked (always 0 for a dry run, or a run
limited by `--passes` or `--namespace`). With `fresh` at 0 only `expire` runs, and the plain
output adds the line `nothing new since the last run; only expiry ran`. Passes appear in the order `expire`, `promote`, `dedupe`, `contradict`, `reflect`, `normalise`.

### sync

One entry per synced mount:

```json
{
  "project": {
    "fetched": 0,
    "merged": [],
    "pushed": [],
    "conflicts": ["remote \"origin\" is not configured; add it with `git remote add origin <url>` and sync again"],
    "skipped": "remote \"origin\" not configured; nothing to sync",
    "retries": 0
  }
}
```

A non-empty `conflicts` on any mount makes the exit code 1, except when `skipped` is set (no such remote): that is a report, printed as `remote "origin" not configured; nothing to sync`, and the exit code is 0.

### status

```json
{
  "name": "ynm",
  "version": "0.1.0",
  "config": ["<repo>/.ynm/config.json"],
  "repo": "<repo>",
  "mounts": [
    { "id": "personal", "level": "personal", "provider": "git-notes", "location": "<home>/store.git", "shards": 1 },
    { "id": "project", "level": "distributed", "provider": "git-notes", "location": "<repo>", "shards": 0 }
  ],
  "index": [
    { "mount": "personal", "fresh": true, "indexed": 1 },
    { "mount": "project", "fresh": true, "indexed": 0 }
  ]
}
```

### doctor

`ok` is false only when a check at level `error` fails; that also makes the exit code 1.

```json
{
  "ok": true,
  "checks": [
    { "name": "git available", "ok": true, "level": "info", "detail": "git version 2.54.0" },
    { "name": "remote", "ok": true, "level": "warn", "detail": "remote \"origin\" not configured; sync unavailable" }
  ]
}
```

### Others

| Command | JSON |
|---|---|
| `import` | `{ "imported": 6, "problems": [] }` |
| `reindex` | memories indexed per mount: `{ "personal": 2, "project": 0 }` |
| `export` | JSONL records, one per line, as in the [record format](record-format.md) |
