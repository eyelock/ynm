#!/bin/sh
# Hosted ynm (runs as uid 1001, so /data must be writable by it): create/adopt the bare memory repo, optionally serve it over git://, run the HTTP server.
#
# ADR-017: never open by accident. The image binds 0.0.0.0, so with none of YNM_JWKS_URL,
# YNM_OAUTH_INTROSPECTION_URL or YNM_MCP_TOKEN set it refuses to start (before the git daemon or
# the store), unless a --no-auth argument says the operator means it.
set -e

has_auth=0
if [ -n "${YNM_JWKS_URL:-}" ] || [ -n "${YNM_OAUTH_INTROSPECTION_URL:-}" ] || [ -n "${YNM_MCP_TOKEN:-}" ]; then
  has_auth=1
fi
no_auth=0
for arg in "$@"; do
  case "$arg" in --no-auth) no_auth=1 ;; --token) has_auth=1 ;; esac
done
host="${YNM_HTTP_HOST:-0.0.0.0}"
case "$host" in
  localhost | 127.* | ::1 | "[::1]") reachable=0 ;;
  *) reachable=1 ;;
esac
if [ "$reachable" = 1 ] && [ "$has_auth" = 0 ] && [ "$no_auth" = 0 ]; then
  echo "ynm: refusing to start: no authentication is configured and the server would listen on $host." >&2
  echo "ynm: set YNM_JWKS_URL, YNM_OAUTH_INTROSPECTION_URL or YNM_MCP_TOKEN, or pass --no-auth (tests and demos only)." >&2
  exit 1
fi

STORE="${YNM_STORE:-/data/store.git}"
mkdir -p "$(dirname "$STORE")" "${YNM_HOME:-/data/home}"
if [ ! -f "$STORE/.ynm/config.json" ]; then
  ynm init --bare "$STORE" >/dev/null
  ynm init --cwd "$STORE" --no-hooks >/dev/null
fi
if [ "${YNM_GIT_DAEMON:-0}" = "1" ]; then
  # git:// has no authentication of its own, so the daemon serves reads only, and only when the
  # HTTP server is protected or --no-auth was given. Pushes need YNM_GIT_DAEMON_PUSH=1, a demo
  # setting: anyone who can reach port 9418 can then write to the store.
  receive_pack=--disable=receive-pack
  if [ "${YNM_GIT_DAEMON_PUSH:-0}" = "1" ]; then
    receive_pack=--enable=receive-pack
    echo "ynm: warning: git daemon accepts unauthenticated pushes (YNM_GIT_DAEMON_PUSH=1); demos only" >&2
  fi
  git daemon --base-path="$(dirname "$STORE")" --export-all "$receive_pack" \
    --reuseaddr --detach --port=9418 --pid-file=/tmp/git-daemon.pid "$(dirname "$STORE")"
fi
exec ynm serve --http --no-personal --cwd "$STORE" --host "$host" --port "${PORT:-3000}" "$@"
