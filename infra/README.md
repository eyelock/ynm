# Infra

What ynm needs in order to run as a hosted service, and the GitHub repository settings.

| Path | What it is |
|---|---|
| [`docker/entrypoint.sh`](docker/entrypoint.sh) | The container entrypoint: creates or adopts the bare memory repository, optionally serves it over `git://`, then starts `ynm serve --http`. The root `Dockerfile` copies it into the image. |
| [`docker/docker-compose.yml`](docker/docker-compose.yml), [`demo.sh`](docker/demo.sh), [`demo-agent.mjs`](docker/demo-agent.mjs), [`clone.sh`](docker/clone.sh) | The hosted demo: a store, an agent with no git that talks MCP over HTTP, and a developer clone that syncs through the store. Run it with `infra/docker/demo.sh`. |
| [`terraform-state/`](terraform-state/README.md) | Terraform for the S3 bucket that holds the Terraform state for everything under `infra/`, and the IAM user that runs it. Applied once to bootstrap, then only to change the bucket or the user. |
| [`github/`](github/README.md) | Terraform for the `eyelock/ynm` repository: settings, branch protection, labels, Actions permissions, variables and secrets, Pages. |

Operating a hosted store (auth, key rotation, backups, scaling):
[`docs/how-to/operate-a-hosted-store.md`](../docs/how-to/operate-a-hosted-store.md).
