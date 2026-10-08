---
"@ynm/cli": patch
"@ynm/service": patch
---

`ynm remember` warns when similar memories already exist, as the MCP tool does: a `note:` line
after `remembered ...`, and a `guidance` string in the JSON. It never refuses.
