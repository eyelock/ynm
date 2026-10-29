---
"@ynm/service": patch
"@ynm/cli": patch
---

`remember`'s note about similar memories now compares a new memory only with memories in its own namespace. A namespace has one owner, so a memory in another one is never a duplicate to supersede; before, two seats writing alike records in their own namespaces were each told to supersede the other's. A write's result now also says the memory's `namespace` and `level`.
