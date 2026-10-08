# Branch Protection Configuration

ynm uses Gitflow. `develop` is the default branch and takes feature, fix and docs pull
requests. `main` takes pull requests only from `develop`, `release/*` and `hotfix/*`, and
carries the release tags (see "Branches and pull requests" in `CONTRIBUTING.md`).

Each of the two long-lived branches is protected by one repository ruleset, and a third ruleset
covers both. There is no classic branch protection: the rulesets are the single source of truth. They are managed in
Terraform, in `infra/github/branches.tf`; change them there, not in the GitHub UI.

| Ruleset | Branch | Required checks |
|---|---|---|
| Develop Branch Protection | `develop` | **All Clear** |
| Main Branch Protection | `main` | **All Clear**, **Verify PR source branch** |
| Never Delete Main or Develop | `main` and `develop` | none (blocks deletion and force pushes; no bypass) |

## Required checks

**All Clear** is the last job of the CI workflow. It depends on every other job (verify,
release gate, coverage) and fails if any of them failed or was cancelled; a job that was skipped
(the release gate runs only on pull requests into `main`) does not fail it. Add or rename CI
jobs freely; only All Clear is required.

**Verify PR source branch** (`protect-main.yml`) fails a pull request into `main` that does not
come from `develop`, `release/*` or `hotfix/*`.

## Rules (both rulesets)

- Changes arrive through a pull request; no approving review is required
- All review conversations must be resolved
- Pull requests do not need to be up to date with their base before merging; the required checks must pass
- Force pushes blocked
- Branch deletion blocked
- Repository admins can bypass the pull request and status check rules in emergencies

## Nobody deletes or force-pushes main or develop

The third ruleset, **Never Delete Main or Develop**, targets `main` and `develop`, blocks
deletion and force pushes, and has no bypass actors. Repository admins cannot delete or
force-push either branch. The first two rulesets let admins bypass, which once included
deletion: on 2026-10-08 GitHub's delete-branch-on-merge, running as an admin, deleted `main`
after a pull request with `main` as its head was merged. Never open a pull request with `main`
or `develop` as its head (see "Back-merge" in `docs/how-to/cut-a-release.md`).

## Merge methods

Squash merge for feature pull requests into `develop`. A true merge commit for release and
hotfix pull requests into `main`, and for their back-merge into `develop`. Rebase merge is off.
