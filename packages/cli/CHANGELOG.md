# @ynm/cli

## 0.2.0

### Minor Changes

- Hosted and team memory. A hosted ynm runs as an HTTP server or an AWS Lambda over an s3 record
  log, with sign-in through an identity provider (Auth0 on AWS, a local Keycloak to develop
  against). Hosted stores know who wrote what: person ids, nicknames, linked logins and a
  metadata-only audit log. Memory is personal by default, and a hosted store keeps a new memory
  only when sharing is chosen. A local ynm can mount a hosted ynm over MCP, so one ynm holds
  personal memory and the team's store; status and recall say why a store was left out. Hosted
  guidance lets URL-only clients remember intents. Agent integrations live under `integrations/`
  with one client-neutral `ynm-memory` skill. Distributed memory lives at
  `refs/notes/ynm/distributed`. Fixes: dream judges only what changed since the last run and calls
  no model when nothing has; `ynm import` reads piped stdin; `init` says what to commit and `sync`
  sets up fetching for a remote added later; the spend guard charges the estimate when a provider
  omits input tokens; the wiki orphan-branch target keeps deeply nested pages; an empty context
  says "no memory yet" instead of a bare heading.

### Patch Changes

- Updated dependencies []:
  - @ynm/index@0.2.0
  - @ynm/mcp@0.2.0
  - @ynm/model@0.2.0
  - @ynm/models@0.2.0
  - @ynm/service@0.2.0
  - @ynm/store@0.2.0
  - @ynm/wiki@0.2.0

## 0.1.1

### Patch Changes

- Standalone single-executable binaries and a slim bundle replace the Node-dependent tarball;
  two Homebrew formulae (`ynm`, `ynm-slim`); `make` is the developer front door; fixes from the
  documentation pass: `git push` exits 0 after the hook syncs, wiki ingest re-derives summaries,
  working memory defaults its TTL, sync without a remote reports it, input validation exits 2,
  descriptions and defaults everywhere; `ynm client status` detects ynh.
- Updated dependencies []:
  - @ynm/mcp@0.1.1
  - @ynm/service@0.1.1
  - @ynm/store@0.1.1
  - @ynm/index@0.1.1
  - @ynm/model@0.1.1
  - @ynm/models@0.1.1
  - @ynm/wiki@0.1.1
