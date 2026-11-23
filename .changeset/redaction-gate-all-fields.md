---
"@ynm/service": patch
---

The redaction gate now checks every string field of a distributed write: subject and tags on remember and supersede, tags, data and reason on annotate, reason on forget, and subject, tags, reason and data on import; and, on every one, the provenance strings (source, session, and on import actor, client and tool) and dataSchema, as ADR-007 promises (ynm #167).
