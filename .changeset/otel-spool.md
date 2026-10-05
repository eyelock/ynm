---
"@ynm/cli": minor
"@ynm/mcp": minor
"@ynm/telemetry": minor
---

Telemetry to a ynr spool. With no OTLP endpoint set, ynm writes its spans, events and metrics as
OTLP JSON lines into the folder `YNR_SPOOL` names, or into ynr's laptop spool,
`~/.local/state/ynr/spool/local` (under `XDG_STATE_HOME` when set), when that folder exists. An
endpoint still wins. Each command, stdio session and function invocation puts its file on disk
as it ends, within 2 seconds; files are capped, and what is dropped is counted in
`ynm.telemetry.spool.dropped` and `ynm.telemetry.spool.errors`. A server started before the spool
exists looks for it once a minute. A hosted server writes to the spool's `services/ynm` folder
when its deployment sets `YNR_SPOOL` to it. With neither an endpoint nor a spool, nothing is
loaded and nothing changes.
