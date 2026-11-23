---
"@ynm/service": patch
---

Supersede, annotate, forget and purge find a memory through the index, which holds its folded state, so an edit by id reads no records at all while the index is fresh. A dream pass over N memories in one namespace is N index lookups, not N scans of that namespace; an id the index does not know still falls back to a full scan (ynm #171).
