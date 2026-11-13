---
"@ynm/cli": patch
"@ynm/mcp": patch
---

Telemetry's `service.version`, the MCP server's `serverInfo.version`, `ynm telemetry registry` and `ynm-mcp --version` report ynm's release, the CLI's version, instead of the `@ynm/mcp` package version (ynm #132). The compiled-in constant is now `RELEASE_VERSION` (was `MCP_VERSION`), generated from `packages/cli/package.json`; a test fails if any of the four drifts.
