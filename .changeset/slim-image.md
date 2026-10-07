---
"@ynm/cli": patch
---

The Docker image is smaller and contains only the runtime: one bundled `ynm.mjs`, Node, git and
tini, with no sources, tests, build cache or dev dependencies (770 MB to about 280 MB). It runs as
a non-root user, uid 1001, and starts the server with `ynm serve --http`. A bind-mounted `/data`
must be writable by uid 1001 (`chown 1001:1001`); a named volume needs nothing.
