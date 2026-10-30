---
"@ynm/service": patch
"@ynm/cli": patch
---

`remember`'s note about similar memories now compares a new memory only with memories in its own namespace. A namespace has one owner, so a memory in another one is never a duplicate to supersede; before, two seats writing alike records in their own namespaces were each told to supersede the other's.

`ynm remember` now says the memory's level and namespace as well as its mount: `remembered <id> in project, level distributed, namespace common`. The mount's name (`project`) read like a level, and the only levels are `personal` and `distributed`. A write's JSON result has `namespace` and `level` too.
