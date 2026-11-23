---
"@ynm/service": minor
"@ynm/mcp": minor
"@ynm/cli": minor
---

A loopback `ynm serve --http` with no authentication configured now requires a local token, as ADR-017 decides: 32 random bytes generated on first start into `serve-token` in the ynm home (mode 600). A request without it is refused, `/health` reports `auth: local-token`, and `ynm client install <client> --http <loopback url>` reads the token itself. `--no-auth` still serves without authentication (ynm #179).
