# A store as a server

One client's store as a small ARM server running the ynm image behind Caddy (TLS from Let's
Encrypt), with a separate data volume that is the store itself (git-notes, so developers' clones
can sync with it, or any other provider). The server is disposable and can be replaced at any
time; the volume moves to the new one. It needs the account's [baseline](../baseline) first.

Not yet deployed for any client; [`clients/example.tfvars.example`](clients/example.tfvars.example)
shows the settings. The overview, credentials and the Lambda alternative are in
[the infra/aws README](../README.md).

## What a store looks like

```text
              https://<client>.ynm.eyelock.net/mcp
                            │
            Elastic IP ─────┤  (survives the server)
                            ▼
┌──────────── server (t4g.small, Amazon Linux 2023) ────────────┐
│  caddy :80/:443 ──► ynm :3000 (MCP over HTTP, dream worker)   │
│                         │                                     │
│   /data ◄── data volume (gp3, label ynm-data, prevent_destroy)│
│     ynm/store.git  ynm/index  ynm/audit  caddy/ (certificates)│
└───────────────────────────────────────────────────────────────┘
     secrets: SSM /ynm/<client>/env/*     logs: CloudWatch /ynm/<client>
     snapshots: daily (baseline)          bundles: s3://ynm-backups-<account>/<client>/
```

- **Access** is through Session Manager (`aws ssm start-session --target <instance_id>`); there
  is no SSH key and no port 22.
- **The server never starts open.** Before Caddy is started the server's `/health` must answer
  and report an authentication mode other than `none`; otherwise the server is removed and the
  `ynm` systemd unit fails, which the health alarm reports.
- **One writer.** Replacing the server stops the old one before its volume is detached, so two
  servers never write the same store.

## Credentials

The `ynm-provisioner` profile, as for every configuration here ([overview](../README.md#credentials)).

## Set up an account

Once per AWS account, with the provisioner profile for that account, from
`accounts/example.tfvars.example` and `example.s3.tfbackend.example` copied to `<account>.*`:

```bash
cd infra/aws/baseline
terraform init -backend-config=accounts/<account>.s3.tfbackend
terraform apply -var-file=accounts/<account>.tfvars
```

While the ynm image is private, the baseline creates `/ynm/registry/credentials`
(`registry_credentials = true`). Put a GitHub token with `read:packages` in it:

```bash
aws ssm put-parameter --overwrite --type SecureString \
  --name /ynm/registry/credentials --value "<github-user>:<token>"
```

When the image is public, set `registry_credentials = false` here and drop
`registry_credentials_parameter` from each client, then replace their servers.

## Add a client

1. Register the store with its identity provider and copy the `auth` object it outputs (for
   Auth0: add it to `stores` in [`infra/auth0`](../../auth0/README.md), apply, then
   `terraform output -json auth`).
2. Copy `clients/example.tfvars.example` to `clients/<client>.tfvars` and
   `example.s3.tfbackend.example` to `clients/<client>.s3.tfbackend`, and set the client name,
   account, auth, image tag, emails and state key.
3. Apply:

   ```bash
   cd infra/aws/server
   terraform init -reconfigure -backend-config=clients/<client>.s3.tfbackend
   terraform apply -var-file=clients/<client>.tfvars
   ```

4. Set the secrets it lists in `secret_parameters` (model keys for the dream worker):

   ```bash
   aws ssm put-parameter --overwrite --type SecureString \
     --name /ynm/<client>/env/TYPESAFE_API_KEY --value "$TYPESAFE_API_KEY"
   ```

   and restart the server so it reads them (below).

5. Confirm the subscription email AWS sends to `alarm_email`.

`-reconfigure` matters when switching clients in the same working directory: it points the
backend at the other client's state instead of offering to copy state across.

## Operate a store

All from `infra/aws/server`, initialised for the client.

| Task | How |
|---|---|
| Upgrade ynm | change `image_tag`, `terraform apply`: a new server, the same volume |
| Throw the server away | `terraform apply -var-file=clients/<client>.tfvars -replace=aws_instance.server` |
| Restart (re-read secrets) | `aws ssm start-session --target <instance_id>`, then `sudo systemctl restart ynm` |
| Grow the disk | raise `volume_size_gb`, apply, then on the server `sudo xfs_growfs /data` |
| Logs | CloudWatch log group `/ynm/<client>`, streams `ynm` and `caddy`; setup in `/var/log/ynm-setup.log` |
| Back up now | on the server, `sudo systemctl start ynm-backup` |

Replacing the server picks up the newest Amazon Linux AMI; a newer AMI alone never replaces a
running server. The store is unreachable for the minute or two a replacement takes.

## Restore or move zones

The data volume lives in one availability zone and the server follows it. To restore from a
snapshot, or to move a store to another zone:

1. Pick the snapshot (`aws ec2 describe-snapshots --filters Name=tag:Client,Values=<client>`).
2. Take the old volume out of Terraform's hands, keeping it until the new one is proven:
   `terraform state rm aws_ebs_volume.data aws_volume_attachment.data`
3. Set `snapshot_id` (and `availability_zone` if moving), then
   `terraform apply -replace=aws_instance.server`.
4. When the store answers, delete the old volume in the console or CLI and remove `snapshot_id`.

The weekly git bundles are the second line: restore one as
[Back up and restore](../../../docs/how-to/back-up-and-restore.md) describes for a hosted store,
onto a fresh volume.

## Cost

Per client, roughly: t4g.small $12/month, 20 GB gp3 $1.60, public IPv4 address $3.60,
snapshots and logs about $1, Route 53 health check $0.50–1. About $20 a month. The baseline adds
the backup bucket's storage and nothing else.
