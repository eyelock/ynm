# ynm on AWS

Hosted ynm stores on AWS, one per client, in either of two shapes. Both serve the same MCP
endpoint, `https://<client>.ynm.eyelock.net/mcp`, take the same `auth` object, and keep secrets in
Parameter Store under `/ynm/<client>/env/`.

| Configuration | One per | What runs | Store | Idle cost |
|---|---|---|---|---|
| [`lambda/`](lambda) | client | a function behind API Gateway, only while it answers | an S3 bucket (the s3 provider) | close to nothing |
| [`server/`](server/README.md) | client | a small server, always on, behind Caddy | a data volume (git-notes or any provider) | about $20/month |
| [`baseline/`](baseline) | account | the VPC, snapshot policy and backup bucket a `server/` store needs | | none |

Choose `lambda/` unless the store must be a git remote developers sync with, or holds so much
that a cold start (listing and reading the store) gets slow. An s3 store can move between the
two: a server mounts the same bucket.

Which account and client a run is for is configuration, not code: a `.tfvars` file and a matching
`.s3.tfbackend` file naming its state key. Both are gitignored and yours to keep; each directory
has an `example.*.example` pair to copy. An account can hold many clients, and clients can be
spread over many accounts.

| State key | Configuration |
|---|---|
| `aws/<account>/lambda/<client>/terraform.tfstate` | `lambda/` with `clients/<client>.*` |
| `aws/<account>/server/<client>/terraform.tfstate` | `server/` with `clients/<client>.*` |
| `aws/<account>/baseline/terraform.tfstate` | `baseline/` with `accounts/<account>.*` |

Sign-in is not here. A store takes an `auth` object (provider, preset, issuer, scopes) and does
not care which identity provider produced it; for an Auth0 tenant that is
[`infra/auth0`](../auth0/README.md). The function gets it as `YNM_AUTH` (JSON) and, for an `oidc`
provider, as the `YNM_JWKS_URL`, `YNM_JWT_ISSUER`, `YNM_JWT_AUDIENCE` and `YNM_REQUIRED_SCOPES` the
server reads today. Each request's audit event goes where `audit_sink` says (`YNM_AUDIT`). Until sign-in ships, a store can use a
static bearer token instead (`auth = null`); the first release with sign-in still accepts it with a
deprecation warning, the release after refuses it. A store never starts without one or the other.

## Credentials

Runs use the `ynm-provisioner` profile. It can use the state bucket and build stores in its
account, and every IAM role it creates carries the `ynm-workload-boundary` permissions boundary,
which caps what any ynm workload can do. Both are defined in
[`infra/terraform-state`](../terraform-state/README.md); make the access key the way that README
describes and add the profile:

```bash
aws configure --profile ynm-provisioner     # region us-east-1
export AWS_PROFILE=ynm-provisioner
```

Each `.tfvars` pins `account_id`, so a run with another account's credentials fails before it
changes anything.

## A store as a Lambda

```text
https://<client>.ynm.eyelock.net/mcp
        │  API Gateway (HTTP API, certificate, throttled; its own URL switched off)
        ▼
  function ynm-<client>  (Node 24, arm64, the ynm Lambda package)
        │  cold start: secrets from SSM /ynm/<client>/env/*, index built in /tmp
        ▼
  s3://ynm-store-<client>-<account>/store/   (versioned; one object per write)

  EventBridge Scheduler: dream every 15 min, compact daily, health every 5 min (keep-warm)
  CloudWatch: log group /ynm/<client>; alarms on function errors and API 5xx → SNS → alarm_email
```

- **ynm checks every token itself.** API Gateway does no auth and passes requests straight
  through, and the function refuses to start if no auth is configured.
- **Concurrent instances are safe.** Each write is a new object with a unique key, so any number
  of instances, a server and the CLI can all use the store at once.
- **A cold start** (the first request after about 5–15 idle minutes, or after a deploy) fetches
  the secrets and builds the index from the store: a second or two for a small store. The
  keep-warm schedule makes most first requests find a warm instance.

### Add a client

1. Build the package at the repository root: `make lambda` (or download `ynm_<v>_lambda.zip`
   from a release).
2. Copy `lambda/clients/example.tfvars.example` and `example.s3.tfbackend.example` to
   `<client>.tfvars` and `<client>.s3.tfbackend`. Set the client name, account, emails and
   `package_version`, and the state key to `aws/<account>/lambda/<client>/terraform.tfstate`. Leave `auth = null` for a static token, or
   paste the store's `auth` object from its identity provider.
3. Apply:

   ```bash
   cd infra/aws/lambda
   terraform init -reconfigure -backend-config=clients/<client>.s3.tfbackend
   terraform apply -var-file=clients/<client>.tfvars
   ```

   The certificate is validated through DNS, which takes a few minutes the first time.

4. Set the secrets it lists in `secret_parameters`. For a static token:

   ```bash
   aws ssm put-parameter --overwrite --type SecureString \
     --name /ynm/<client>/env/YNM_MCP_TOKEN --value "$(openssl rand -hex 32)"
   ```

   and a model key for the dream judge the same way (`TYPESAFE_API_KEY`; see the judge and writer how-to for others). A parameter left at
   `unset` is ignored. Until a token is set the function refuses to start, so nothing is exposed.

5. Confirm the subscription email AWS sends to `alarm_email`.
6. Connect an agent: `ynm client install claude-code --http https://<client>.ynm.eyelock.net/mcp
   --token <token>`.

`-reconfigure` matters when switching clients in the same working directory: it points the
backend at the other client's state instead of offering to copy state across.

### Operate it

All from `infra/aws/lambda`, initialised for the client.

| Task | How |
|---|---|
| Upgrade ynm | build or download the new package, set `package_version`, `terraform apply` |
| Pick up a changed secret | `aws lambda update-function-configuration --function-name ynm-<client> --description "secrets $(date +%F)"` starts fresh instances |
| Logs | CloudWatch log group `/ynm/<client>` |
| Run the dream now | `aws lambda invoke --function-name ynm-<client> --payload '{"ynm":"dream"}' --cli-binary-format raw-in-base64-out /dev/stdout` |
| Back up | the bucket is versioned; `ynm export` against the store for portable JSONL |

### Cost

For one person's store, all within free tiers or pennies: Lambda (1M requests and 400,000 GB-s a
month free), API Gateway ($1 per million requests), S3 storage and requests (cents), Scheduler
(14M invocations a month free), Parameter Store standard parameters (free), logs (cents). Under
$1 a month; a busy team store stays in single dollars.

## A store as a server

See [`server/README.md`](server/README.md): the server, its data volume, the account baseline,
upgrading, replacing the server, restore and moving zones.
