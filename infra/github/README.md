# GitHub repository

Terraform for the `eyelock/ynm` repository's settings, so the repository can be checked for
drift and set up again from nothing.

| File | What it manages |
|---|---|
| `repository.tf` | The repository: description, homepage, topics, visibility, features, merge options; GitHub Pages from `/docs` on `main` |
| `branches.tf` | `develop` as the default branch; protection on `main` and `develop` (PR required, required checks, admins included, no force-push or delete) |
| `labels.tf` | Issue and PR labels, authoritatively: a label not listed is removed |
| `actions.tf` | Actions permissions, the read-only default `GITHUB_TOKEN`, the `YNM_MILESTONE` variable, the `RELEASE_TOKEN` and `YNR_READ_PACKAGES` secrets, the `github-pages` environment |
| `security.tf` | Dependabot alerts and security updates |
| `imports.tf` | Import blocks that adopt the live repository into a fresh state |

Not managed here:

- Anything committed to the repository: workflows, `CODEOWNERS`, `dependabot.yml`, the issue
  and pull request templates. They live under `.github/`.
- `eyelock/homebrew-tap`, which the release workflow pushes formulae to. ynh's Terraform owns
  it (`terraform/eyelock_tap` in `eyelock/ynh`).
- The value of `RELEASE_TOKEN`. GitHub never returns it, so Terraform writes it only when it
  creates the secret.
- The value of `YNR_READ_PACKAGES`, a classic token with only the `read:packages` scope that CI,
  release and the Docker build install `@eyelock/otel-spool-exporter` from GitHub Packages with.
  The same holds: Terraform writes it only when it creates the secret.
- The value of `YNM_MILESTONE`, which moves with the milestones. Terraform writes it only when it
  creates the variable.

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

To set or rotate `YNR_READ_PACKAGES`, create a new classic token with only `read:packages` and
change the secret on GitHub (it prompts for the value, so the token is not in your shell history):

```bash
gh secret set YNR_READ_PACKAGES --repo eyelock/ynm
```

Terraform ignores the value once the secret exists, so this never shows as drift.
`TF_VAR_ynr_read_packages` is needed only if the secret is created from nothing.

The repository has `prevent_destroy` and `archive_on_destroy`, so `terraform destroy` stops,
and removing that guard archives the repository rather than deleting it.

## Set up from nothing

For a new owner or name, set `owner` and `repository`, then:

1. Delete `imports.tf`: there is nothing to import.
2. Create only the repository:
   `terraform apply -target=github_repository.ynm`.
3. Push `main` and `develop` from a clone (`git push <new-remote> main develop --tags`). The
   default branch, protections and Pages need the branches to exist.
4. Apply the rest, with both tokens and the gate, since the secrets and the variable are being
   created: `TF_VAR_release_token=<token> TF_VAR_ynr_read_packages=<token> TF_VAR_milestone=<id>
   terraform apply`.

The protections require the `verify`, `coverage` (on `develop`) and `Verify PR source branch`
checks, which report once the workflows have run on a pull request.
