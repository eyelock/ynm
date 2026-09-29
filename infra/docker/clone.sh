#!/bin/sh
# A developer clone: the hosted store is just a git remote; shared notes sync over git://.
set -e
git clone -q git://store/store.git /work
cd /work
ynm init --no-hooks >/dev/null
ynm sync
echo "--- memories visible in the clone:"
ynm list --json | grep -o '"content": *"[^"]*"'
ynm remember --type semantic --level distributed --content "Written from the clone; pushed back to the hosted store" >/dev/null
ynm sync
echo "--- pushed one memory back"
