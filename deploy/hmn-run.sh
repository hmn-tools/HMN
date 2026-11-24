#!/bin/sh
# Supervises the HMN server: rotates the log, then restarts Bun if it exits
# or the log grows past a megabyte. launchd keeps this script alive. When
# launchd stops the job, the server gets the signal at once and closes cleanly.
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$here/lib.sh"

log=${HMN_LOG:?}
server=${HMN_SERVER_DIR:?}
bun=${HMN_BUN:?}
mkdir -p "$(dirname "$log")"
chmod 700 "$(dirname "$log")" || true

child=""
sleeper=""

# launchd sends TERM to this script when the job stops. The server then gets
# TERM at once, saves the graph, and removes its working copy. A shell does not
# run a trap while it waits for a foreground command, so each sleep below is a
# background process that "wait" watches.
stop() {
  if [ -n "$sleeper" ]; then
    kill "$sleeper" 2>/dev/null || true
  fi
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

nap() {
  sleep "$1" &
  sleeper=$!
  wait "$sleeper" 2>/dev/null || true
  sleeper=""
}

while true; do
  hmn_rotate_log "$log" 1048576
  start=$(date +%s)
  (
    cd "$server"
    # shellcheck disable=SC2094
    exec >>"$log" 2>&1
    exec "$bun" src/index.ts
  ) &
  child=$!
  while kill -0 "$child" 2>/dev/null; do
    nap 2
    if [ -f "$log" ]; then
      size=$(wc -c < "$log" | tr -d ' ')
      if [ "$size" -gt 1048576 ]; then
        kill "$child" 2>/dev/null || true
        break
      fi
    fi
  done
  wait "$child" 2>/dev/null || true
  child=""
  now=$(date +%s)
  if [ $((now - start)) -lt 8 ]; then
    nap 10
  else
    nap 1
  fi
done
