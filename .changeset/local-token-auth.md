---
"@ynm/service": minor
"@ynm/mcp": minor
"@ynm/cli": minor
---

A loopback `ynm serve --http` with no authentication configured now requires a local token, as ADR-017 decides: 32 random bytes generated on first start into `serve-token` in the ynm home (mode 600). A request without it is refused, `/health` reports `auth: local-token`, and `ynm client install <client> --http <loopback url> --scope user` reads the token itself. The start-up line names the token file and never prints the token, and with `--scope project` (the default) and no `--token` the install is refused, so the token is never written into a file in the work tree. `--no-auth` still serves without authentication (ynm #179).
