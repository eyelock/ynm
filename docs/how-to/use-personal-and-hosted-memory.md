# Use personal memory with a hosted store

Goal: keep your own memory private on your machine while also reading, and deliberately sharing
into, a team's hosted store. Memory is personal by default; sharing is something you choose, one
memory at a time.

## Mount the hosted store

Add the hosted store to your local ynm as a mount, in `~/.ynm/config.json`:

```json
{
  "mounts": [
    { "id": "team", "level": "distributed", "provider": "mcp", "url": "https://memory.example.com/mcp" }
  ]
}
```

Then sign in, once:

```bash
ynm login team
```

`ynm login` opens the browser at the store's identity provider and keeps the credentials in
`~/.ynm/auth/team.json`, readable only by you; they refresh on their own. `ynm doctor` shows
whether you are signed in, and `ynm logout team` forgets the credentials.

Install ynm in your agent client as usual (`ynm client install claude-code`). The agent then talks
to one ynm, which reaches the hosted store for you over MCP, signed in as you.

## What happens

- **"Remember this" stays personal.** A memory that names no level goes to your personal store
  and never leaves your machine.
- **Sharing is a request.** A memory with `level: distributed` goes to the hosted store when there
  is no project store to take it (name the mount, `team`, to choose it over a project store).
  There it is attributed to you and audited, like any write to the hosted store. To share
  something you already remember, promote it: `ynm promote <id>` copies it to the hosted store,
  and the personal original stays where it is.
- **Recall and context read both.** Results from your personal store and the hosted store come
  back as one list, ranked together, each labelled with its mount. The context block at the start
  of a session has your memory first and a `Shared memory (team)` section after it.
- **Edits go where the memory is.** Superseding, annotating or forgetting a memory by id works on
  the hosted store's memories too.
- **Offline is fine.** If the hosted store cannot be reached, or you are not signed in, reads
  answer from personal memory and say the shared store was left out; session start waits at most
  three seconds for it. A shared write fails with the reason rather than landing somewhere else.

Tutorial 10 shows all of this against a local server and identity provider.

## Or: two servers side by side

Without a mount, an agent can also be given both stores as separate MCP servers:

```bash
ynm client install claude-code
claude mcp add --scope user --transport http ynm-team https://memory.example.com/mcp
```

The agent then has two sets of tools (`mcp__ynm__memory_recall`, `mcp__ynm-team__memory_recall`).
Unnamed writes still stay personal, because the hosted server stores nothing unless a memory is
shared on purpose, but the agent searches each store separately and gets two context blocks.

## Want to review before anything is shared?

Use a project store as well as, or instead of, the hosted one: `ynm init` in the repository gives
the local ynm a distributed level backed by git notes. Shared memories are written to your clone
first and reach the team only when `ynm sync` pushes them, and `ynm promote <id>` copies a
personal memory into the project store when you decide it belongs there. See
[Share an org store](share-an-org-store.md) and tutorial 8.
