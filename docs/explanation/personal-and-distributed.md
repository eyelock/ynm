# Personal and distributed memory

Every memory ynm stores has a `level`, and there are only two: `personal` and `distributed`.
The level decides where a memory is written, who can ever see it, and whether sync moves it.
This page explains why the boundary is binary, how it is enforced, and how a memory crosses it.

## Two stores, not two flags

**Personal memory** lives in your own store, a bare git repository at `~/.ynm/store.git`. It is
created the first time you need it and it has no remote unless you add one. Your preferences,
your corrections, what you learned about a codebase you are only visiting: all personal, and by
default everything is.

**Distributed memory** lives in the project: in the repository's own notes refs under
`refs/notes/ynm/distributed/`, or in a dedicated repository for distributed memory mounted alongside. It is what the
team should know: decisions and why, the procedure that works, the dashboard everyone needs.

The important part is that these are two different places, not one place with a visibility
flag. A project repository never holds a `personal` ref at all. So there is no push, mirror job
or hand-typed `git push origin 'refs/notes/*'` that can leak personal memory, because it is not
there to leak. Tools that store everything in one place and filter on the way out are one bug,
or one careless command, away from publishing everything.

## Why only two levels

It is tempting to add levels: personal, team, project, organisation. ynm does not, because the
privacy boundary really is binary: either something may leave your machine or it may not.
Everything finer than that is about grouping, not privacy, and grouping is what namespaces are
for. `org/eyelock/team/platform` and `project/ynm` are namespaces inside distributed memory, and
which remote a store syncs to decides the audience. A third level would add a second way to say
the same thing and a new place to get it wrong.

The level is fixed when a memory is written. It is not a field you edit later; it decides which
log the record is appended to, and the mount table refuses a personal record on a distributed
log.

## The redaction gate

Distributed memory is shared, so it is checked before it is written. Every distributed write,
and every write a consolidation pass makes, is matched against a list of patterns: private key
headers, cloud and forge tokens, API keys, bearer tokens. A match refuses the write with the
pattern that fired; nothing is silently dropped or rewritten. The list is configuration
(`redaction`), so a team can add its own.

Personal writes are not matched against the patterns, because they never leave your machine
unless you push your own store somewhere yourself.

With a calibrated Judge configured there is a second layer, and it covers every new memory,
personal included: the judge is asked whether the content contains a secret, credential or
personal data, and a confident yes refuses the write the same way a pattern does. Patterns catch
the shapes you know; the judge catches the ones you did not list.

## Sync respects the boundary

`ynm init` adds a fetch refspec for `refs/notes/ynm/distributed/*` only, and a pre-push hook that
syncs them (the hook is the only thing that pushes notes). `ynm sync` fetches, merges and pushes distributed shards. It does not touch the
personal store unless you name the personal mount and give an explicit remote, which is how you
back your personal memory up to a private repository of your own.

## Crossing the boundary: promotion

Sometimes something you learned alone turns out to be a team fact. `ynm promote <id>` copies a
personal memory into a distributed mount as a new memory, linked `derives-from` the original.
The copy is matched against the redaction patterns like any distributed write, and a memory in
your `user/<id>` namespace lands in `common`; any other namespace is kept. The personal original is
left exactly as it was: promotion is a copy, not a move, so nothing about your own history
changes and the link records where the team's copy came from.

There is no demotion. Once a fact has been shared it has been fetched by other clones; the
honest way to withdraw it is to supersede or forget it in the distributed store, which every clone
will see on its next sync.

## Recall spans both

Keeping the stores apart does not mean searching them apart. Recall and the context block
read every mount, rank the results together and label each hit with its mount and level, so an
agent sees your personal preference and the team's decision side by side and can tell which is
which.

## Choosing a level

- A preference, a correction, a note to yourself, anything about another person: personal.
- A decision the team made and why, a procedure that works here, a pointer everyone needs:
  distributed, if it contains nothing secret.
- Not sure: personal. Promotion is one command later; un-sharing is not possible.

The guidance agents receive says the same thing, and it is why personal is the default, everywhere.
Sharing is chosen, never defaulted: a hosted server has no personal store, so there a memory that
names no level is not stored at all. The agent is told the store is shared with everyone who uses
it and to ask before sharing; only a call that says `distributed` is stored. Connecting to a
hosted server is agreeing that what you share there is shared. To keep your own memory beside it,
a local ynm mounts the hosted store: personal memory stays on your machine, and the hosted store
is reached through it, signed in as you
([Use personal memory with a hosted store](../how-to/use-personal-and-hosted-memory.md)).
