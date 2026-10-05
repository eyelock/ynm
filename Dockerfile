# syntax=docker/dockerfile:1
# ynm hosted service (ADR-009): Streamable HTTP MCP server in front of a bare git repo (or sqlite),
# single writer, dream worker on a timer. `docker compose -f infra/docker/docker-compose.yml up`.
#
# Installing needs a GitHub token with read:packages for @eyelock/otel-spool-exporter, passed as a
# BuildKit secret so it is in no layer and no build arg:
#   docker build --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t ynm:local .
FROM node:26-alpine AS build
# Node 25+ no longer bundles corepack; install it, then activate the pnpm that package.json pins.
RUN apk add --no-cache git && npm install -g corepack && corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs turbo.json ./
COPY packages ./packages
COPY integrations ./integrations
RUN --mount=type=secret,id=node_auth_token,env=NODE_AUTH_TOKEN \
    pnpm install --frozen-lockfile
RUN pnpm build

FROM node:26-alpine
RUN apk add --no-cache git git-daemon tini && \
    git config --system user.name ynm && git config --system user.email ynm@localhost && \
    git config --system safe.directory '*'
WORKDIR /app
COPY --from=build /app /app
COPY infra/docker/entrypoint.sh /usr/local/bin/ynm-entrypoint
RUN printf '#!/bin/sh\nexec node /app/packages/cli/bin/run.js "$@"\n' > /usr/local/bin/ynm && \
    printf '#!/bin/sh\nexec node /app/packages/mcp/bin/run.js "$@"\n' > /usr/local/bin/ynm-mcp && \
    chmod +x /usr/local/bin/ynm /usr/local/bin/ynm-mcp /usr/local/bin/ynm-entrypoint
ENV YNM_HOME=/data/home \
    YNM_STORE=/data/store.git \
    YNM_HTTP_HOST=0.0.0.0 \
    PORT=3000 \
    YNM_NO_CLAUDE_CLI=1
VOLUME ["/data"]
EXPOSE 3000 9418
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/ynm-entrypoint"]
