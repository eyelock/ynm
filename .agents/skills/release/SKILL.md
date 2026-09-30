---
name: ynm-release
description: Cut an ynm release: version bump, frozen baselines, benchmark reports, tag, standalone and slim artefacts, Homebrew tap.
---

# release

1. Changesets landed; `pnpm release:version` bumps versions (0.1.0 shipped without one).
2. Freeze evals for the version: `YNM_BASELINE_VERSION=<v> YNM_WRITE_BASELINE=1 pnpm bench`, then
   `pnpm bench:public`; commit `packages/evals/baselines/<v>.json` and `packages/evals/reports/<v>/`.
3. `pnpm gate M6` must be green. It builds the slim tarball (`scripts/release/build-slim.mjs`) and
   this machine's standalone binary (`fetch-node.mjs`, `build-standalone.mjs`; needs the exact
   Node in `.nvmrc`), smoke-tests both with `scripts/release/smoke.mjs`, and renders both formulae.
4. Tag `v<version>` and push. `.github/workflows/release.yml` builds the four standalone binaries
   (macos-14 and ubuntu-24.04 runners) and the slim tarball, attaches them with `manifest.json`
   and `checksums.txt` to the GitHub release, pushes `Formula/ynm.rb` and `Formula/ynm-slim.rb`
   to `eyelock/homebrew-tap` (needs the `RELEASE_TOKEN` secret), and pushes the ghcr image.

A new CLI command must be added to `packages/cli/src/commands/index.ts` (the bundle has no
commands directory); a test fails when one is missing.

Details: `docs/how-to/cut-a-release.md`. Users' side: `docs/how-to/install.md`.
