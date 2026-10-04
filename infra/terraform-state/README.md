# Terraform state backend

Where the Terraform under `infra/` keeps its state: an S3 bucket in `us-east-1`, plus the IAM
users that day-to-day runs use. ynm has its own; astrolock, acme and collective each have theirs.

This is its own configuration with its own state, so a plan or apply elsewhere under `infra/`
uses the bucket but never touches it. It is applied once to bootstrap, and after that only to
change the bucket or the users.

Locking is S3's own (`use_lockfile`): a run writes `<key>.tflock` beside the state and removes it
when done, so Terraform 1.10 or later is needed.

| Resource | Name |
|---|---|
| State bucket (versioned, encrypted, no public access; old versions expire after 90 days) | `ynm-terraform-state.eyelock.net` |
| IAM group, policy and user: read and write state and its lock objects, nothing else | `ynm-terraform` |
| IAM group, policy and user: build hosted stores in this account ([`infra/aws`](../aws/README.md)); also in the `ynm-terraform` group | `ynm-provisioner` |
| Permissions boundary every role `infra/aws` creates must carry, under a path the provisioner cannot change | `ynm-boundary/ynm-workload-boundary` |

Each configuration has its own key in the bucket:

| Configuration | Key |
|---|---|
| `infra/terraform-state` (this one) | `terraform-state/terraform.tfstate` |
| [`infra/github`](../github/README.md) | `github/terraform.tfstate` |
| [`infra/auth0`](../auth0/README.md), per tenant | `auth0/<tenant>/terraform.tfstate` |
| [`infra/aws/lambda`](../aws/README.md), per client | `aws/<account>/lambda/<client>/terraform.tfstate` |
| [`infra/aws/server`](../aws/README.md), per client | `aws/<account>/server/<client>/terraform.tfstate` |
| [`infra/aws/baseline`](../aws/README.md), per account with server stores | `aws/<account>/baseline/terraform.tfstate` |

Configurations that serve several tenants, accounts or clients leave `key` out of their backend
block and take it from a `.s3.tfbackend` file at `terraform init -backend-config=…`.

A run that dies can leave a lock behind; `terraform force-unlock <id>` (the id is in the error)
removes it.

A new configuration copies the `backend "s3"` block from `infra/github/versions.tf` with a key of
its own.

## Credentials

Day-to-day runs use the `ynm-terraform` profile. Its access key is made with the AWS CLI rather
than Terraform, so the secret never enters state:

```bash
aws iam create-access-key --user-name ynm-terraform    # with an admin profile
aws configure --profile ynm-terraform                  # paste the key; region us-east-1
```

Rotate it the same way: create a second key, reconfigure the profile, then
`aws iam delete-access-key --user-name ynm-terraform --access-key-id <old>`.

Runs that build infrastructure (`infra/aws`) use the `ynm-provisioner` profile instead, made the
same way (`aws iam create-access-key --user-name ynm-provisioner`, then
`aws configure --profile ynm-provisioner`). It can use the state too, so one profile is enough
for those runs. It can create IAM roles only under `/ynm/` and only with the
`ynm-workload-boundary` boundary, which caps what any ynm workload can do; it cannot change the
boundary, other IAM users, or this configuration. The regions it may build in and the DNS names
it may create (`*.ynm.eyelock.net`) are locals at the top of `provisioner.tf`.

Changing this configuration (the bucket or the IAM resources) needs an admin profile:
neither the `ynm-terraform` nor the `ynm-provisioner` user can change the infrastructure around
the state.

```bash
cd infra/terraform-state
AWS_PROFILE=<admin> terraform init
AWS_PROFILE=<admin> terraform plan
```

## Bootstrap

This configuration stores its state in the bucket it creates, so the first apply runs on local
state and then moves it in. Once, with an admin profile:

```bash
cd infra/terraform-state
export AWS_PROFILE=<admin>
printf 'terraform {\n  backend "local" {}\n}\n' > backend_override.tf
terraform init
terraform apply
rm backend_override.tf
terraform init -migrate-state      # answer yes: copies the local state into the bucket
rm terraform.tfstate*
```

The bucket has `prevent_destroy`; removing it loses every configuration's state.
