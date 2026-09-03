#!/usr/bin/env bash
# Make postgres reachable, whatever state the machine is in. Idempotent and safe to run every time.
#
# An unattended run cannot ask anyone to start a container, and on macOS the podman VM does not come
# back by itself after a reboot. So: start the VM if it is down, start the stack if it is down, wait
# until postgres actually answers — and never touch the data volume.
#
#   scripts/ensure_db.sh          → exit 0 when postgres answers, 1 with a reason when it cannot
set -uo pipefail

cd "$(dirname "$0")/.."

PORT="${SMITH_DB_PORT:-5433}"
DEADLINE=$((SECONDS + 180))

say() { echo "ensure_db: $*"; }

reachable() {
  # A TCP connect is enough and needs no client installed.
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null && exec 3<&- && return 0
  return 1
}

ready() {
  podman exec smith-postgres pg_isready -U smith -d reviewer >/dev/null 2>&1
}

if reachable && ready; then
  say "postgres already up on :${PORT}"
  exit 0
fi

command -v podman >/dev/null 2>&1 || { say "podman is not installed"; exit 1; }

# 1. The VM. `podman info` fails when it is down, which is the only reliable probe.
if ! podman info >/dev/null 2>&1; then
  say "podman machine is down, starting it (this takes a minute)"
  podman machine start >/dev/null 2>&1 || true
  while ! podman info >/dev/null 2>&1; do
    [ $SECONDS -lt $DEADLINE ] || { say "podman machine did not come up in time"; exit 1; }
    sleep 3
  done
  say "podman machine up"
fi

# 2. The container. `compose up -d` covers created-but-stopped and missing alike.
if ! podman ps --format '{{.Names}}' | grep -qx smith-postgres; then
  say "starting the postgres container"
  # Only postgres: the compose file also carries the api and web images, and this script must not
  # build them to make a database reachable.
  podman start smith-postgres >/dev/null 2>&1 || podman compose up -d postgres >/dev/null 2>&1 || {
    say "could not start smith-postgres"; exit 1;
  }
fi

# 3. Accepting connections. A running container is not the same as a ready database.
while ! ready; do
  [ $SECONDS -lt $DEADLINE ] || { say "postgres did not become ready in time"; exit 1; }
  sleep 2
done

say "postgres ready on :${PORT}"
