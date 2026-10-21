---
"@ynm/service": patch
"@ynm/cli": patch
---

`ynm client install ynh` now adds ynm's store, identity and configuration variables (`YNM_HOME`, `YNM_USER` and the like) to the harness's `env_passthrough`. ynh hides every other variable from a worker, so without them the MCP server and hooks silently used `~/.ynm`, your real personal store. `ynm client status` and `ynm doctor` report a harness without `YNM_HOME` as not fully configured, and `ynm doctor` warns in a ynh worker where `YNM_HOME` is unset.
