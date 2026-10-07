# Choose the S3 provider

Goal: keep a store in an S3 bucket instead of git notes. Choose it for a hosted store that
should cost next to nothing when idle, or that several processes write at once: a server, a
function, a CLI on a laptop. Nobody needs git to reach it, and no process has to be the single
writer.

## What changes

| | git-notes (default) | s3 |
|---|---|---|
| Storage | records as git notes in a repository | JSON lines in objects under a bucket prefix |
| Writers | one process per store | any number at once; every write is a new object |
| Sharing | any git remote; `ynm sync` merges | anyone with access to the bucket; `ynm sync` has nothing to send |
| History | a git commit per write | the same append-only record log; old versions too if the bucket is versioned |
| Backup | `git bundle`, a mirror on a forge | bucket versioning, replication, or a copy of the prefix |

The record format, ranking and the wiki are the same. A store's objects sit at
`<prefix>/<level>/<namespace>/<type>/<yyyy-mm>/<id>.jsonl`, one object per write per shard, so
writers never overwrite each other and need no lock. The index stays on local disk, as with the
other providers, and is rebuilt from the bucket when it is missing.

## Which ynm can mount it

The s3 provider ships in the Docker image and in a source checkout. The Homebrew formulae, the
standalone binaries and the slim tarball leave it out to stay small; with one of those, a mount
that asks for it fails with `this build of ynm does not include the s3 provider`.

## Turn it on

Add a mount to the `config.json` the server reads: the served repository's `.ynm/config.json`,
or `~/.ynm/config.json`.

```json
{
  "mounts": [
    {
      "id": "team",
      "level": "distributed",
      "provider": "s3",
      "bucket": "example-org-ynm",
      "prefix": "stores/team",
      "region": "eu-west-2"
    }
  ]
}
```

`bucket` is required; `path` is not used. `prefix` keeps several stores in one bucket; leave it
out to use the bucket root. `region` defaults to the AWS environment (`AWS_REGION` or the
shared config). Credentials come from the standard AWS chain: environment variables, a profile,
or the role of the container or function. `ynm status` shows the mount as
`s3://example-org-ynm/stores/team`, and `ynm doctor` reports its object and record counts, any line it
could not read, and whether the bucket keeps versions.

The identity needs these actions on the bucket and prefix:

| Action | For |
|---|---|
| `s3:ListBucket` | reading and listing the store |
| `s3:GetObject`, `s3:PutObject` | reading and writing records |
| `s3:DeleteObject` | `ynm purge`, and folding many small objects into one |
| `s3:GetBucketVersioning` | `ynm doctor` (optional; it reports `unknown` without it) |
| `s3:ListBucketVersions`, `s3:DeleteObjectVersion` | `ynm purge --forget-history` on a versioned bucket |

The bucket must support conditional writes (`If-None-Match` and `If-Match` on PUT). Amazon S3
does, and so do current MinIO releases.

## Purge and history

`ynm purge` rewrites each object that holds the memory, without its lines, and deletes an
object it leaves empty. On a versioned bucket the old versions still hold the lines;
`--forget-history` deletes those versions too. Turn versioning on if you want deleted or
overwritten objects recoverable, and leave lifecycle rules off the store prefix: expiring an
object loses the records in it.

## Switching an existing store

There is no in-place conversion. Export from the old store and import into the new one:

```bash
ynm export > memory.jsonl
```

Add the s3 mount, then `ynm import --mount team memory.jsonl`. Ids and history come across. Export is per store and includes tombstones and purge markers.
