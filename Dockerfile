# syntax=docker/dockerfile:1
# ynm hosted service (ADR-009): Streamable HTTP MCP server in front of a bare git repo (or sqlite),
# single writer, dream worker on a timer. `docker compose -f infra/docker/docker-compose.yml up`.
#
# Two stages. The build stage installs the workspace, builds it and bundles the CLI with esbuild
# (scripts/release/bundle.mjs --with-s3): one ESM file, ynm.mjs, with the guidance markdown
# embedded and the s3 provider and AWS SDK included. The runtime stage is node:26-alpine with git,
# git-daemon and tini (npm, corepack, yarn and the Node headers removed), that one file at
# /app/ynm.mjs, and nothing else from the repository: no sources, tests, dev dependencies or build
# cache. It runs as the unprivileged user ynm (uid 1001, as the ynf factory image does); /data,
# the volume, belongs to that user, so a bind mount must be writable by uid 1001. The server is
# `ynm serve --http`, the same code as the ynm-mcp binary.
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
COPY scripts ./scripts
# The user npmrc names the variable, not the token, and is removed in the same step.
RUN --mount=type=secret,id=npm_token,env=NODE_AUTH_TOKEN \
    echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' > /root/.npmrc && \
    pnpm install --frozen-lockfile && \
    rm /root/.npmrc
RUN pnpm build && node scripts/release/bundle.mjs --with-s3

FROM node:26-alpine
RUN apk add --no-cache git git-daemon tini && \
    git config --system user.name ynm && git config --system user.email ynm@localhost && \
    git config --system safe.directory '*' && \
    adduser -D -u 1001 -h /data/home ynm && \
    mkdir -p /data && chown ynm:ynm /data && \
    rm -rf /usr/local/lib/node_modules /usr/local/include/node /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /opt/yarn-*
WORKDIR /app
COPY --from=build /app/dist-release/ynm.mjs /app/ynm.mjs
COPY infra/docker/entrypoint.sh /usr/local/bin/ynm-entrypoint
RUN printf '#!/bin/sh\nexec node /app/ynm.mjs "$@"\n' > /usr/local/bin/ynm && \
    chmod +x /usr/local/bin/ynm /usr/local/bin/ynm-entrypoint
ENV YNM_HOME=/data/home \
    YNM_STORE=/data/store.git \
    YNM_HTTP_HOST=0.0.0.0 \
    PORT=3000 \
    YNM_NO_CLAUDE_CLI=1
USER 1001
VOLUME ["/data"]
EXPOSE 3000 9418
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/ynm-entrypoint"]
