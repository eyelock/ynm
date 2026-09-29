---
name: ynm-release
description: Cut an ynm release: version bump, frozen baselines, benchmark reports, tag, Homebrew tap.
---

# release

1. Changesets landed; `pnpm release:version` bumps versions (0.1.0 shipped without one).
2. Freeze evals for the version: `YNM_BASELINE_VERSION=<v> YNM_WRITE_BASELINE=1 pnpm bench`, then
   `pnpm bench:public`; commit `packages/evals/baselines/<v>.json` and `packages/evals/reports/<v>/`.
3. `pnpm gate M6` must be green (it also builds the tarball with `scripts/release/pack.mjs`).
4. Tag `v<version>` and push. `.github/workflows/release.yml` publishes the GitHub release, pushes
   `Formula/ynm.rb` to `eyelock/homebrew-tap` (needs the `RELEASE_TOKEN` secret) and the ghcr image.

Details: `docs/how-to/cut-a-release.md`.
