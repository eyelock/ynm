---
name: ynm-deploy
description: Run or deploy the hosted ynm service: Docker image, compose demo, auth modes, scheduler.
---

# deploy

```bash
export YNR_READ_PACKAGES=$(gh auth token)   # read:packages, for @eyelock/otel-spool-exporter
docker build --secret id=ynr_read_packages,env=YNR_READ_PACKAGES -t ynm:local .
docker run -d -p 3000:3000 -v ynm-data:/data -e YNM_MCP_TOKEN=change-me -e YNM_DREAM_EVERY=15m ynm:local
curl -s http://localhost:3000/health
infra/docker/demo.sh          # store + git-less agent + syncing clone, then tears down
```

Auth is chosen from the environment: `YNM_JWKS_URL` (JWT), `YNM_OAUTH_INTROSPECTION_URL` (RFC 7662),
`YNM_MCP_TOKEN` (static), else none. `docs/how-to/operate-a-hosted-store.md` covers rotation, backups
and scaling. The hosted integration tests need a Docker daemon: `make test-hosted`.
