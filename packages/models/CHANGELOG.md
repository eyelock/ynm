# @ynm/models

## 0.1.1

### Patch Changes

- Standalone single-executable binaries and a slim bundle replace the Node-dependent tarball;
  two Homebrew formulae (`ynm`, `ynm-slim`); `make` is the developer front door; fixes from the
  documentation pass: `git push` exits 0 after the hook syncs, wiki ingest re-derives summaries,
  working memory defaults its TTL, sync without a remote reports it, input validation exits 2,
  descriptions and defaults everywhere; `ynm client status` detects ynh.
- Updated dependencies []:
  - @ynm/model@0.1.1
