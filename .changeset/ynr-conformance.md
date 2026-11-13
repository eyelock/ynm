---
"@ynm/cli": patch
"@ynm/service": patch
"@ynm/telemetry": patch
---

`ynr conformance` passes against ynm and runs in CI (ynm #131). The telemetry registry's manifest is `telemetry/registry/manifest.yaml`, as in ynr, ynh and ynf, and the CLI command and store-call spans are named `ynm.command` and `ynm.store` (the command and the call are the `ynm.command.name` and `ynm.store.operation` attributes), so each matches its `started` event.
