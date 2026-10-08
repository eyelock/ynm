---
name: ynm-release
description: Cut an ynm release: version bump, frozen baselines, benchmark reports, tag, standalone and slim artefacts, Homebrew tap.
---

# release

0. Gitflow: cut `release/vX.Y.Z` from `develop`; do steps 1-3 on it; PR it into `main` (true
   merge), then back-merge into `develop`; tag on `main`. Delete-on-merge removes `release/vX.Y.Z`
   when its PR merges, so cut a temporary branch from main for the back-merge
   (`git switch -c chore/back-merge-vX.Y.Z origin/main && git push -u origin chore/back-merge-vX.Y.Z`),
   open a PR from it into `develop` and merge it with a merge commit. Or open the back-merge PR
   from `release/vX.Y.Z` before merging the release PR. NEVER open a PR with `main` itself as
   the head: merging it deletes `main`. Never commit to
   `main` or `develop` directly.
1. Changesets landed on `develop`; `make version` on the release branch bumps versions.
2. Freeze evals for the version: `YNM_BASELINE_VERSION=<v> YNM_WRITE_BASELINE=1 make bench`, then
   `make bench-public`; commit `packages/evals/baselines/<v>.json` and `packages/evals/reports/<v>/`.
3. `make gate M=M6` must be green, including no regression against the previous release's
   baseline and reports (a deliberate trade-off goes in `baselines/<v>.accepted.json` with a
   reason; never re-run a suite until it passes, and never drop a key to hide a drop). It builds the slim tarball (`scripts/release/build-slim.mjs`) and
   this machine's standalone binary (`fetch-node.mjs`, `build-standalone.mjs`; needs the exact
   Node in `.nvmrc`), smoke-tests both with `scripts/release/smoke.mjs`, and renders both formulae.
4. After the release PR is merged into `main`, tag `v<version>` there and push the tag. `.github/workflows/release.yml` builds the four standalone binaries
   (macos-26 and ubuntu-24.04 runners) and the slim tarball, attaches them with `manifest.json`
   and `checksums.txt` to the GitHub release, pushes `Formula/ynm.rb` and `Formula/ynm-slim.rb`
   to `eyelock/homebrew-tap` (needs the `RELEASE_TOKEN` secret), and pushes the ghcr image.

A new CLI command must be added to `packages/cli/src/commands/index.ts` (the bundle has no
commands directory); a test fails when one is missing.

Details: `docs/how-to/cut-a-release.md`. Users' side: `docs/how-to/install.md`.
