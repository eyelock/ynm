# Share an org store

Goal: keep memory that spans many repositories (organisation-wide conventions, shared runbooks)
in one dedicated repository on your forge, mounted next to each project's own memory. Background:
the dedicated-repo topology in [ADR-009](../adr/009-hosting-and-bootstrap.md).

## Create the store

The store is a bare git repository used only for memory. Create it locally and give it the forge
repository, which must already exist and can be empty, as its `origin`:

```bash
ynm init --bare ~/.ynm/org.git
git -C ~/.ynm/org.git remote add origin git@forge.example.com:eyelock/org-memory.git
git -C ~/.ynm/org.git rev-list --max-parents=0 main
```

`init --bare` prints a short anchor. The last command prints the full 40-character root commit,
which is the anchor every mount of this store must use. Keep it.

## Mount it

Add the store to `mounts` in `.ynm/config.json` of each project that should see it (or once, in
`~/.ynm/config.json` for every project on your machine):

```json
{
  "mounts": [
    {
      "id": "org",
      "level": "distributed",
      "provider": "git-notes",
      "path": "/home/you/.ynm/org.git",
      "anchor": "<the 40-character root commit>",
      "remote": "origin"
    }
  ]
}
```

`ynm status` now lists an `org` mount beside `personal` and `project`.

## Write and sync

Target the mount with `--mount`, and use a namespace that says whose memory it is:

```bash
ynm remember --type semantic --level distributed --mount org --namespace org/eyelock --content "Deploys need two approvals."
ynm sync --mount org
```

`ynm sync` with no flag syncs every replicating distributed mount, this one included, so the
pre-push hook keeps it current too. Recall searches all mounts; restrict it with `--mount org` or
`--namespace org/eyelock`.

## Onboard a teammate

Each teammate needs a local bare repository with the same remote, and the same mount entry with
the same anchor:

```bash
git init --bare ~/.ynm/org.git
git -C ~/.ynm/org.git remote add origin git@forge.example.com:eyelock/org-memory.git
ynm sync --mount org
```

Do not use `git clone --mirror` for the local copy: a mirror refuses the refspecs `ynm sync`
pushes with, and the sync fails with `--mirror can't be combined with refspecs`.

## Keep in mind

- Everything in the org store passes the redaction gate, like any distributed write.
- Personal memory is never synced here. `ynm promote <id>` copies a personal memory into a
  distributed mount as a new, linked memory; give it `--mount org` to target this one.
- Forge permissions are the access control: whoever can push to the repository can write memory.
