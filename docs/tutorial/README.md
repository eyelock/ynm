# ynm Tutorial Series

Ordered lessons from a first memory to running benchmarks. Each tutorial builds on the previous
one but can be run on its own; each starts by wiping and recreating its sandbox.

Every tutorial is also an acceptance test. Each step is a command block followed by the output
you should see. A model can read a tutorial, run it and check it, exactly as you would; see
[Running tutorials as evals](RUNNING.md).

## Tutorials

### Remember and recall

| Tutorial | What you will learn |
|---|---|
| [1. First memory](01-first-memory.md) | Create your personal store, remember two facts, recall them, see what was written to git |
| [2. Project memory](02-project-memory.md) | `ynm init` in a repository, distributed memory, namespaces, the redaction gate |
| [3. Recall and context](03-recall-and-context.md) | Filters, tags, subjects, score explanations, the context block, pinning |
| [4. Editing history](04-editing-history.md) | Supersede, annotate, forget, purge, export and import |
| [5. Sessions and working memory](05-sessions-and-working-memory.md) | Session start and end, TTLs, expiry |

### Share

| Tutorial | What you will learn |
|---|---|
| [6. Sync](06-sync.md) | A bare remote, two clones, concurrent writes merged, the pre-push hook |
| [7. Connect an agent](07-connect-an-agent.md) | `client install` for every supported client, `serve` over stdio, a scripted MCP call |

### Consolidate

| Tutorial | What you will learn |
|---|---|
| [8. Dreaming](08-dreaming.md) | Dry runs, the heuristic judge, and with a key: dedupe, contradict, review queue, promote |
| [9. Wiki projection](09-wiki.md) | Build the markdown wiki, edit a page and ingest it, the orphan branch target |

### Operate

| Tutorial | What you will learn |
|---|---|
| [10. Hosted service](10-hosted.md) | `serve --http` with a token, health, the Docker demo, a clone syncing through it |
| [11. Doctor and maintenance](11-doctor-and-maintenance.md) | Doctor, reindex, the sqlite provider, backup and restore |
| [12. Evals and benchmarks](12-evals-and-benchmarks.md) | `make bench`, milestone gates, `bench:public` |

Tutorials without a link are planned; the table is the order they will arrive in.

## Install

<!-- tabs:start -->

#### **Homebrew (recommended)**

```bash
brew install eyelock/tap/ynm        # standalone: one executable, needs only git
# or: brew install eyelock/tap/ynm-slim   (the same program on Homebrew's node)
ynm --version
```

Direct downloads, the slim tarball on your own Node and the Docker image are in
[Install ynm](../how-to/install.md).

#### **From source**

Requires Node 22.13 or later and pnpm.

```bash
git clone https://github.com/eyelock/ynm.git
cd ynm
make deps
make install          # writes ~/.ynm/bin/ynm, a launcher for this checkout; prints the PATH line if needed
export PATH="$HOME/.ynm/bin:$PATH"
ynm --version
```

Expected: `@ynm/cli/<version>-dev.<sha> <platform> node-v<version>`; the `-dev.<sha>` suffix says
you are running the checkout, not a release.

<!-- tabs:end -->

## The sandbox

Every tutorial starts with the same block. It points ynm at a throwaway home so your real
personal store is never touched, and fixes the user id so namespaces match the expected output:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
cd /tmp/ynm-tutorial
```

Steps that need a paid model key or a particular tool are marked and can be skipped.
