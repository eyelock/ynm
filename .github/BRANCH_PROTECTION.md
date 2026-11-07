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
(the release gate runs only on pull requests and queue entries into `main`; coverage runs only on pull requests) does not fail it. Add or rename CI
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

## Merge queue

Both rulesets carry a merge queue. A pull request that is green and has its conversations resolved
is added with "Merge when ready"; the queue builds a temporary `merge_group` ref of it on top of
the entries ahead and runs CI there (`ci.yml` and, for `main`, `protect-main.yml` trigger on
`merge_group`). **All Clear** must pass on that ref, and the pull request merges only then. This
is what stops two green pull requests combining red. The queue builds up to 5 entries at once,
groups only when all are green, waits 5 minutes for a second entry, and times a check out after
60 minutes.

## Merge methods

The queue's method replaces the per-pull-request choice: `develop`'s queue squashes (feature
pull requests); `main`'s makes a merge commit (release and hotfix pull requests). Rebase merge is
off.

**The back-merge is the exception.** The back-merge of `main` into `develop` once per release
(`chore/back-merge-vX.Y.Z`, see `docs/how-to/cut-a-release.md`) must be a true merge commit, or
`develop` loses `main`'s history and the next release pull request diverges. `develop`'s queue
would squash it, so a repository admin merges it around the queue (the ruleset's admin bypass,
"Merge without waiting for requirements") choosing "Create a merge commit". Never queue it.
