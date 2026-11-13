---
"@ynm/mcp": patch
"@ynm/models": patch
"@ynm/service": patch
---

The request, tool, remote, model and dream spans have fixed names, `ynm.request`, `ynm.tool`, `ynm.remote`, `ynm.model`, `ynm.dream` and `ynm.dream.pass`, with the method and route, tool, provider and pass in attributes, so each matches its `started` event (ynr rule 5, ynm #151). A dashboard or query that matched the old names, such as `tools/call memory_recall` or `model claude-cli`, matches the attributes instead. A conformance scenario runs `ynm dream --dry-run`.
