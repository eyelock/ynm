# Releasing ynm

1. Land changesets on `main` (`pnpm changeset` for each user-visible change). 0.1.0 is the
   initial version the packages were born with, so it ships without a changeset.
2. `pnpm release:version` bumps package versions and CHANGELOGs from the changesets; commit.
3. Freeze the evals for the version: `YNM_BASELINE_VERSION=<v> YNM_WRITE_BASELINE=1 pnpm bench`
   and the tier 1 quality suites, then `pnpm bench:public` for the tier 3 reports
   (`packages/evals/reports/<v>/`). Commit both.
4. Tag `v<version>` and push the tag. The `release` workflow then:
   - re-runs build, check, typecheck, tests and the M6 gate;
   - builds the self-contained CLI tarball (`scripts/release/pack.mjs`: `pnpm deploy` of
     `@ynm/cli`, production dependencies only) and attaches it to a GitHub release;
   - renders `Formula/ynm.rb` (`scripts/release/formula.mjs`) and pushes it to
     `github.com/eyelock/homebrew-tap`, so `brew install eyelock/tap/ynm` works next to `ynh`;
   - pushes `ghcr.io/eyelock/ynm:<version>` and `:latest` (linux/amd64 and arm64).

The formula depends on Homebrew's `node` (22.13 or later, for `node:sqlite`) and `git`; the
tarball carries everything else. `ynm serve` is the MCP server, so one formula covers the CLI,
the stdio server clients launch, and the hosted service.

Secrets: `RELEASE_TOKEN` in the ynm repository must be a token with write access to
`eyelock/homebrew-tap` (the same convention ynh uses). `GITHUB_TOKEN` covers the release and
the image.

Local dry run: `node scripts/release/pack.mjs 0.1.0` then
`node scripts/release/formula.mjs 0.1.0 $(cut -d' ' -f1 dist-release/ynm-0.1.0.tar.gz.sha256)`.
