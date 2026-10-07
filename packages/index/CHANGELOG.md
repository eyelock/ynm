# @ynm/index

## 0.3.1

### Patch Changes

- Updated dependencies [[`e00db04`](https://github.com/eyelock/ynm/commit/e00db04fff915b30899f688517820b5376e04397)]:
  - @ynm/store@0.4.0

## 0.3.0

### Minor Changes

- Occurrences, structured recall and clearer identities. A memory tagged `occurrence` records one
  event where repetition is the signal: dream never merges or supersedes it, still reflects on it,
  and keeps it out of the session-start context; after `dream.occurrenceRetention` (default 90
  days, `null` to keep them) dream retires old occurrences, except those the newest reflection on
  their subject was written from (a reflection now links only the episodes it was written from).
  Recall hits carry a memory's `data`, `dataSchema` and `source`. On a hosted store, a write made
  with a static token is recorded as `token:static` and one from an identity-provider token with no
  subject as `client:<id>`, never as the server's own user. The hosted function logs one line per
  request (method, path, status, duration, MCP method and tool, auth kind), answers before API
  Gateway's 30 seconds run out even after a slow cold start, and its alarms page on a sustained
  error rate rather than a single burst. The release binaries for macOS build on macos-26.

### Patch Changes

- Updated dependencies []:
  - @ynm/model@0.3.0
  - @ynm/store@0.3.0

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
  - @ynm/model@0.2.0
  - @ynm/store@0.2.0

## 0.1.1

### Patch Changes

- Standalone single-executable binaries and a slim bundle replace the Node-dependent tarball;
  two Homebrew formulae (`ynm`, `ynm-slim`); `make` is the developer front door; fixes from the
  documentation pass: `git push` exits 0 after the hook syncs, wiki ingest re-derives summaries,
  working memory defaults its TTL, sync without a remote reports it, input validation exits 2,
  descriptions and defaults everywhere; `ynm client status` detects ynh.
- Updated dependencies []:
  - @ynm/store@0.1.1
  - @ynm/model@0.1.1
