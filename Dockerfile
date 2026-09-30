# ynm hosted service (ADR-009): Streamable HTTP MCP server in front of a bare git repo (or sqlite),
# single writer, dream worker on a timer. `docker compose -f infra/docker/docker-compose.yml up`.
FROM node:24-alpine AS build
RUN apk add --no-cache git && corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY packages ./packages
COPY integrations ./integrations
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-alpine
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
