# Use personal memory with a hosted store

Goal: keep your own memory private on your machine while also reading, and deliberately sharing
into, a team's hosted store. Memory is personal by default; sharing is something you choose, one
memory at a time.

## Connect both

Install ynm locally for your personal memory, then add the hosted store as a second MCP server
under its own name:

```bash
ynm client install claude-code
claude mcp add --scope user --transport http ynm-team https://memory.example.com/mcp
```

The first gives the agent a local `ynm` server over stdio, with your personal store. The second
adds the hosted store as `ynm-team`; on first use, `/mcp` signs you in through the store's
identity provider. Claude Code keeps the two apart by name (`mcp__ynm__memory_recall`,
`mcp__ynm-team__memory_recall`).

## What happens

- **"Remember this" stays personal.** A memory that names no level goes to the local server, which
  stores it in your personal store. The hosted server stores nothing unless the call says
  `level: distributed`, and its instructions tell the agent to ask you first, so nothing reaches
  the team because a level was left out.
- **Sharing is a request.** Say "share that with the team" (or "remember this for the team"), and
  the agent stores it on `ynm-team` with `level: distributed`. There it is attributed to you,
  filed under your own namespace unless the agent names one such as `common`, and audited.
- **Recall reads both.** Ask about a preference or a past decision and the agent can recall from
  each server. Results come back per server, each ranked on its own.

## Want to review before anything is shared?

Use a project store instead of, or as well as, the hosted one: `ynm init` in the repository gives
the local ynm a distributed level backed by git notes. Shared memories are written to your clone
first and reach the team only when `ynm sync` pushes them, and `ynm promote <id>` copies a
personal memory into the project store when you decide it belongs there. See
[Share an org store](share-an-org-store.md) and tutorial 8.
