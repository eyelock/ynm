---
"@ynm/mcp": patch
"@ynm/cli": patch
---

`ynm serve --http` and the Docker image refuse to start with no authentication on a non-loopback bind, unless `--no-auth` is given (ADR-017); the image's git daemon is read-only unless `YNM_GIT_DAEMON_PUSH=1` (ynm #165).
