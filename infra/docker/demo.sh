#!/bin/sh
# The hosted demo (ADR-009): a store, an agent with no git, a developer clone that syncs.
# Usage: infra/docker/demo.sh [project-name]
set -e
cd "$(dirname "$0")"
P="${1:-ynm-demo}"
compose() { docker compose -f docker-compose.yml -p "$P" "$@"; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
compose build store
compose up -d --wait store
echo "=== agent (HTTP, no git)"
compose run --rm agent
echo "=== clone (git remote = the hosted store)"
compose run --rm clone
echo "=== store health"
docker run --rm --network "${P}_default" --entrypoint sh ynm:local -c 'wget -qO- http://store:3000/health'
echo
