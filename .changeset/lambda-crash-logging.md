---
"@ynm/mcp": patch
---

A hosted function now logs why its process went away, which Lambda alone does not: an uncaught exception or promise rejection with its stack, the exit code, or a SIGTERM, each with the request or scheduled run in progress at the time (or `between invocations`). A fatal error inside Node is reported on stderr as one line, without the function's environment. Before, such a crash left only Lambda's `Runtime.ExitError` and an empty `500` for the client.
