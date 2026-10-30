---
"@ynm/service": patch
"@ynm/cli": patch
---

A `--mount` naming a mount that does not exist is now refused with exit 2 and the mounts there are: `no mount "projet" (have: personal, project, team)`. Before, `recall`, `context`, `list`, `export`, `review`, `reindex`, `sync` and `wiki build` matched nothing and exited 0, so a typo, or `--mount project` run outside an initialised repository, looked like an empty store.
