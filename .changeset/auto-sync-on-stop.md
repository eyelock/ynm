---
"@ynm/service": minor
"@ynm/cli": minor
"@ynm/store": patch
---

A new `sync.auto` setting (off by default) syncs distributed memory in the background from the agent's Stop hook. When it is on and a distributed mount has writes the remote has not seen, the hook starts `ynm sync --quiet` detached: a full fetch, merge and push, never the personal store, and the turn does not wait for it. It runs at most once per `sync.intervalMinutes` per repository (default and minimum 5, because the Stop hook opens the store once per 5 minutes per session; at most 1440), and a write made inside the interval goes out at the first Stop after it. Errors never reach the session.

A successful `ynm sync` now records what the remote holds in the remote-tracking refs for the notes and documents it pushed, so unpushed writes can be detected locally with no network.
