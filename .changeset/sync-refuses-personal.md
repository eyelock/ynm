---
"@ynm/service": patch
"@ynm/cli": patch
---

`Ynm.sync` now refuses a personal mount unless the caller sets `allowPersonal`, which only `ynm sync --mount personal --remote <name>` does. The `memory_sync` tool can no longer push the personal store by naming `mount: "personal"` (ynm #168).
