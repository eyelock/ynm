# GitHub repository

Terraform for the `eyelock/ynm` repository's settings, so the repository can be checked for
drift and set up again from nothing.

| File | What it manages |
|---|---|
| `repository.tf` | The repository: description, homepage, topics, visibility, features (issues, discussions and projects on, wiki off), merge options (squash and merge commit on, rebase off), secret scanning when public; GitHub Pages from `/docs` on `main` |
| `branches.tf` | `develop` as the default branch; one repository ruleset each for `develop` and `main` (see Rulesets) |
| `labels.tf` | Issue and PR labels, authoritatively: a label not listed is removed |
| `actions.tf` | Actions permissions, the read-only default `GITHUB_TOKEN`, the `YNM_MILESTONE` variable, the `RELEASE_TOKEN` secret, the `github-pages` environment |
| `security.tf` | Dependabot alerts and security updates (both on) |
| `imports.tf` | Import blocks that adopt the live repository into a fresh state |

Not managed here:

- Anything committed to the repository: workflows, `CODEOWNERS`, `dependabot.yml`, the issue
  and pull request templates. They live under `.github/`.
- `eyelock/homebrew-tap`, which the release workflow pushes formulae to. ynh's Terraform owns
  it (`terraform/eyelock_tap` in `eyelock/ynh`).
- The value of `RELEASE_TOKEN`. GitHub never returns it, so Terraform writes it only when it
  creates the secret.
- The `YNR_READ_PACKAGES` secret, a classic token with only `read:packages` that installs
  `@eyelock/otel-spool-exporter` from GitHub Packages. It is set by hand with
  `gh secret set YNR_READ_PACKAGES --repo eyelock/ynm`, like the other siblings' ynr tokens.
- The value of `YNM_MILESTONE`, which moves with the milestones. Terraform writes it only when it
  creates the variable.

## Rulesets

Two repository rulesets replace classic branch protection, so each branch has one list of rules
(the same text is in [`.github/BRANCH_PROTECTION.md`](../../.github/BRANCH_PROTECTION.md)):

| Ruleset | Branch | Required checks |
|---|---|---|
| Develop Branch Protection | `develop` | `All Clear` |
| Main Branch Protection | `main` | `All Clear`, `Verify PR source branch` |

Both block deletion and force pushes, require a pull request with every conversation resolved and
no approving review, require the branch to be up to date (strict), and let repository admins
(role 5) bypass. `All Clear` is the last job of `ci.yml`; it depends on every other job, so
adding or renaming CI jobs never touches this configuration.

## Security

Dependabot alerts and security updates are on. Secret scanning and push protection are on only
when `visibility` is `public`, because they need a public repository. `visibility` stays `private`
until the repository is made public; that is a separate, confirmed change
(`terraform apply -var visibility=public`).

Private vulnerability reporting, which `SECURITY.md` points to, is not in Terraform: the
`integrations/github` provider has no resource for it. Turn it on in Settings, Code security, or with
`gh api -X PUT repos/eyelock/ynm/private-vulnerability-reporting`.

## Use

Needs Terraform 1.10 or later, a GitHub token with the `repo` and `workflow`
scopes, and the `ynm-terraform` AWS profile. State is in S3 at
`s3://ynm-terraform-state.eyelock.net/github/terraform.tfstate`, locked with a `.tflock` object
beside it; the bucket comes from [`../terraform-state`](../terraform-state/README.md). It holds
no secrets, and if it is ever lost the import blocks rebuild it from the live repository.

```bash
cd infra/github
export AWS_PROFILE=ynm-terraform
export GITHUB_TOKEN="$(gh auth token)"
terraform init
terraform plan     # no changes means the repository matches this configuration
terraform apply
```

To change a setting, edit the `.tf` file, `plan`, then `apply`. A change made in the GitHub UI
shows as drift in the next `plan`; either copy it into the configuration or `apply` to undo it.

When the gate moves to a new milestone, change the variable on GitHub:
`gh variable set YNM_MILESTONE --body <id>`. Terraform writes it only when it creates it, so the
change does not show as drift.

To rotate `RELEASE_TOKEN`:

```bash
TF_VAR_release_token=<token> terraform apply -replace=github_actions_secret.release_token
```

The repository has `prevent_destroy` and `archive_on_destroy`, so `terraform destroy` stops,
and removing that guard archives the repository rather than deleting it.

## Set up from nothing

For a new owner or name, set `owner` and `repository`, then:

1. Delete `imports.tf`: there is nothing to import.
2. Create only the repository:
   `terraform apply -target=github_repository.ynm`.
3. Push `main` and `develop` from a clone (`git push <new-remote> main develop --tags`). The
   default branch, rulesets and Pages need the branches to exist.
4. Apply the rest, with the release token and the gate, since the secret and the variable are
   being created: `TF_VAR_release_token=<token> TF_VAR_milestone=<id> terraform apply`.

The rulesets require the `All Clear` and `Verify PR source branch` checks, which report once the
workflows have run on a pull request.
