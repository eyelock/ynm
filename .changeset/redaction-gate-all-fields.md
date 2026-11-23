---
"@ynm/service": patch
---

The redaction gate now checks every string field of a distributed write: subject and tags on remember and supersede, tags, data and reason on annotate, reason on forget, and subject, tags, reason and data on import, as ADR-007 promises (ynm #167).
