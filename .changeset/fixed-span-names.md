---
"@ynm/cli": patch
"@ynm/mcp": patch
"@ynm/models": patch
"@ynm/service": patch
"@ynm/telemetry": patch
---

Every ynm span has a fixed name equal to its `started` event's unit, as ynr conformance rule 5 needs (ynm #151): `ynm.request`, `ynm.tool`, `ynm.remote`, `ynm.model`, `ynm.dream` and `ynm.dream.pass`, joining `ynm.command` and `ynm.store`. The variable part (HTTP method and route, tool, model provider, dream pass) is in the attributes it already had. Dashboards and queries that match the old names (`POST /mcp`, `tools/call memory_recall`, `model claude-cli`, `dream`, `dream dedupe`) must match the new names and filter on those attributes.
