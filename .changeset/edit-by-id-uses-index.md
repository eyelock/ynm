---
"@ynm/service": patch
---

Supersede, annotate, forget and purge find a memory through the index, which names its mount, namespace and type, and read only those shards, not every record of every mount. A dream pass over N memories no longer reads N times the whole store; an id the index does not know still falls back to a full scan (ynm #171).
