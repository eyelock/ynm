---
"@ynm/model": patch
"@ynm/index": patch
"@ynm/store": patch
"@ynm/store-s3": patch
---

A namespace filter with a trailing slash now matches, so `--namespace factory/` finds the same
memories as `--namespace factory`. This applies to list, recall, context, export, session and
dream, over the CLI, MCP and HTTP.
