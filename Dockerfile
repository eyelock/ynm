# syntax=docker/dockerfile:1
# ynm hosted service (ADR-009): Streamable HTTP MCP server in front of a bare git repo (or sqlite),
# single writer, dream worker on a timer. `docker compose -f infra/docker/docker-compose.yml up`.
#
# @eyelock/otel-spool-exporter is public, but GitHub's npm registry still needs a token with
# read:packages (any GitHub account's), passed as a BuildKit secret so it is in no layer and no
# build arg:
#   NODE_AUTH_TOKEN=$(gh auth token) docker build --secret id=npm_token,env=NODE_AUTH_TOKEN -t ynm:local .
FROM node:26-alpine AS build
# Node 25+ no longer bundles corepack; install it, then activate the pnpm that package.json pins.
RUN apk add --no-cache git && npm install -g corepack && corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY packages ./packages
COPY integrations ./integrations
# The user npmrc names the variable, not the token, and is removed in the same step.
RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN \
    echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > /root/.npmrc && \
    pnpm install --frozen-lockfile && \
    rm /root/.npmrc
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
