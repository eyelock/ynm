---
"@ynm/store": patch
"@ynm/service": patch
---

A purge now survives a sync. The purge marker is authoritative when records are folded: every record of a purged memory is dropped, so lines a sync brings back from a clone that wrote to the same shard are never returned by recall, list, context, the wiki or export. After a sync, `ynm` also removes such lines, keeps the marker and syncs again so the removal reaches the remote (ynm #175).
