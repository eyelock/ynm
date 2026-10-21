# Wiki Projection

Turn memory into a folder of Markdown pages you can read, grep, open in an editor or browse on a
forge. The wiki is a view generated from the log, never the source of truth, so this tutorial
also shows the one way an edit travels back: `wiki ingest`.

## Prerequisites

`ynm` is on your PATH. Prepare the sandbox, a personal store, and a repository with ynm
initialised in it:

```bash
rm -rf /tmp/ynm-tutorial
mkdir -p /tmp/ynm-tutorial
export YNM_HOME=/tmp/ynm-tutorial/home
export YNM_USER=tutorial
export YNM_NO_CLAUDE_CLI=1
cd /tmp/ynm-tutorial
ynm init --personal
git init -q -b main project
cd project
git -c user.name=tutorial -c user.email=tutorial@example.com commit -q --allow-empty -m "first commit"
ynm init
```

Expected: `personal store created at /tmp/ynm-tutorial/home/store.git`, then the `initialised`
report from tutorial 2 with the note that remote `origin` was not found.

## Three memories to project

Two of them share a subject, so the wiki will give that subject a page of its own:

```bash
ynm remember --type semantic --level distributed --content "Deploys happen on Tuesdays." --tags deploy --subject entity:deploys
ynm remember --type procedural --level distributed --content "Run pnpm check before pushing." --tags ci
ynm remember --type episodic --level distributed --content "The Monday deploy failed on a migration lock." --tags deploy --subject entity:deploys
```

Expected: three `remembered <26-character id> in project` lines.

## Build the wiki

```bash
ynm wiki build
```

Expected: one line per mount that has content, with the number of pages written and where. The
personal mount is empty, so it gets only the two fixed pages, an index and a log.

```text
personal: 2 pages -> /tmp/ynm-tutorial/home/wiki/personal
project: 8 pages -> <project path>/.ynm/wiki
```

Eight pages for three memories: an index, a log, one page per memory (three), one page for the
`entity:deploys` subject, and one for each of the tags `ci` and `deploy`.

```bash
find .ynm/wiki -type f | sed 's/[0-9A-Z]\{26\}/<id>/' | sort
```

Expected:

```text
.ynm/wiki/entities/deploys.md
.ynm/wiki/index.md
.ynm/wiki/log.md
.ynm/wiki/memories/<id>.md
.ynm/wiki/memories/<id>.md
.ynm/wiki/memories/<id>.md
.ynm/wiki/topics/ci.md
.ynm/wiki/topics/deploy.md
```

The wiki lives under `.ynm/wiki`, next to the config. Git ignores it: `ynm init` listed it in
`.git/info/exclude`, and the folder holds a `.gitignore` of `*` that does the same in every clone. To commit the wiki instead, remove that line, or use the orphan-branch
target below, which keeps it in git without touching your working branch.

## Read the index

```bash
cat .ynm/wiki/index.md
```

Expected: a frontmatter block (`type: "index"`, `generated: true`, a timestamp and
`memories: 3`), then a `# Memory: project` heading and one line per memory, grouped under
`## distributed · common · <type>` headings, each a link to the memory's page with its subject
after a dot:

```text
## distributed · common · semantic

- [Deploys happen on Tuesdays.](memories/<id>.md) · entity:deploys
```

Every page opens with frontmatter that follows the Open Knowledge Format, so other tools that
read it can index the wiki. The other two pages worth a look are `log.md`, one
`## [date] <op> | <summary>` line per record in the log, and `entities/deploys.md`, which lists
the two memories that share the subject.

## Edit a page and ingest it

Wiki files are output. Editing one changes nothing by itself. To send an edit back, edit the
memory's page and hand it to `ynm wiki ingest`, which records it as a supersede. Correct the
deploy day in the page's body, leaving the frontmatter alone:

```bash
PAGE=$(grep -l "Deploys happen on Tuesdays" .ynm/wiki/memories/*.md)
sed -i.bak '$s/Tuesdays/Wednesdays/' "$PAGE"
rm "$PAGE.bak"
ynm wiki ingest "$PAGE"
```

Expected: one line, `superseded <id> from the edited page`. The frontmatter's `memoryId` told
ynm which memory the page belongs to.

Run it again and nothing happens, because the content already matches:

```bash
ynm wiki ingest "$PAGE"
```

Expected: `no change for <id>`.

The memory now has a second version, and recall returns the corrected text:

```bash
ynm recall --text "Wednesdays" --json
```

Expected: a JSON array of one hit, of type `semantic` and level `distributed`, whose `content`
and `summary` are both `Deploys happen on Wednesdays.`.

Only the body is read back, and it is enough. The page's heading is the memory's one-line
summary; when the body changed and the heading did not, `ingest` lets ynm derive a fresh summary
from the new content, as `ynm supersede` does. Edit the heading as well and your heading becomes
the summary.

## The orphan branch target

A directory is private to your working copy. To publish the wiki with the repository, build it
onto an orphan branch, `ynm/wiki`, which shares no history with your code:

```bash
ynm wiki build --target orphan-branch --mount project
git log ynm/wiki --oneline
```

Expected: `project: 8 pages -> <project path>#ynm/wiki`, then one commit,
`<short sha> ynm: wiki (8 pages)`. Each build adds a commit.

The branch holds the same files, now with the corrected page:

```bash
git ls-tree -r --name-only ynm/wiki
git branch
```

Expected: the eight pages, without the `.ynm/wiki/` prefix (`entities/deploys.md`, `index.md`,
`log.md`, three under `memories/`, two under `topics/`), and a branch list of `* main` and
`ynm/wiki`. Your checked-out files did not change; the branch was written without touching the
working tree. Push it like any branch (`git push origin ynm/wiki`) and a forge renders the
pages, links and all.

## Cleanup

```bash
cd /tmp
rm -rf /tmp/ynm-tutorial
unset YNM_HOME YNM_USER YNM_NO_CLAUDE_CLI PAGE
```

Next: tutorial 10, the hosted service, where the same memory is served over HTTP.
