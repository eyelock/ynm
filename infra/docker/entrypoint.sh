#!/bin/sh
# Hosted ynm: create/adopt the bare memory repo, optionally serve it over git://, run the HTTP server.
set -e
STORE="${YNM_STORE:-/data/store.git}"
mkdir -p "$(dirname "$STORE")" "${YNM_HOME:-/data/home}"
if [ ! -f "$STORE/.ynm/config.json" ]; then
  ynm init --bare "$STORE" >/dev/null
  ynm init --cwd "$STORE" --no-hooks >/dev/null
fi
if [ "${YNM_GIT_DAEMON:-0}" = "1" ]; then
  # Lets local clones use the hosted store as their git remote (fetch and push of distributed notes).
  git daemon --base-path="$(dirname "$STORE")" --export-all --enable=receive-pack \
    --reuseaddr --detach --port=9418 --pid-file=/tmp/git-daemon.pid "$(dirname "$STORE")"
fi
exec ynm-mcp --http --no-personal --cwd "$STORE" --host "${YNM_HTTP_HOST:-0.0.0.0}" --port "${PORT:-3000}" "$@"
