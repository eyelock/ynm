---
"@ynm/cli": patch
"@ynm/telemetry": patch
---

`ynm telemetry registry --format json` now prints the same shape as the other YN tools: the tool
and version, the semantic-conventions release, then the attributes, standard attributes, spans,
events and metrics. The names themselves are unchanged.
