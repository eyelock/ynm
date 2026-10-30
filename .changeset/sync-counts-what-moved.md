---
"@ynm/store": patch
"@ynm/cli": patch
---

`ynm sync` counts only what it moved. `fetched` is the number of refs the fetch brought something new for, and `pushed` lists the refs the push changed on the remote, so a sync with nothing to move reports `fetched 0, merged 0, pushed 0`. Before, it reported every ref the remote had as fetched and every local ref as pushed, so a run couldn't show whether anything changed.

A command whose output is cut short, such as `ynm sync --json | head`, now exits 0 quietly. Before, it exited 13 with Node's "unsettled top-level await" warning on stderr.
