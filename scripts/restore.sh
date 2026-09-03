#!/usr/bin/env bash
# Restore a dump over the reviewer database.
#
# This DROPS the database first. Everything in it right now is replaced by whatever the dump holds,
# and open connections are terminated.
#
#   scripts/restore.sh                          → newest file in backups/, asks before dropping
#   scripts/restore.sh backups/x.dump --yes     → no question asked (drills, cron)
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${SMITH_PG_CONTAINER:-smith-postgres}"
DB="${SMITH_DB_NAME:-reviewer}"
DB_USER="${SMITH_DB_USER:-smith}"
DIR="${SMITH_BACKUP_DIR:-backups}"

FILE=""
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
  --yes) ASSUME_YES=1 ;;
  *) FILE="$arg" ;;
  esac
done

say() { echo "restore: $*"; }

if [ -z "$FILE" ]; then
  FILE="$(ls -t "${DIR}"/*.dump 2>/dev/null | head -1 || true)"
  [ -n "$FILE" ] || {
    say "no dump given and none found in ${DIR}/"
    exit 1
  }
fi
[ -f "$FILE" ] || {
  say "no such file: ${FILE}"
  exit 1
}

podman exec "$CONTAINER" pg_isready -U "$DB_USER" -d postgres >/dev/null 2>&1 || {
  say "postgres is not answering in container ${CONTAINER}; run scripts/ensure_db.sh"
  exit 1
}

# Read the archive before destroying anything: a truncated dump must cost nothing.
podman exec -i "$CONTAINER" pg_restore --list <"$FILE" >/dev/null 2>&1 || {
  say "${FILE} is not a readable archive, nothing was touched"
  exit 1
}

if [ "$ASSUME_YES" -eq 0 ]; then
  [ -t 0 ] || {
    say "refusing to drop ${DB} without a terminal to confirm on; pass --yes if you mean it"
    exit 1
  }
  printf 'restore: this drops database %s and replaces it with %s. Type yes to continue: ' "$DB" "$FILE"
  read -r answer
  [ "$answer" = "yes" ] || {
    say "cancelled, nothing was touched"
    exit 1
  }
fi

psql_admin() { podman exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

# Separate statements: DROP DATABASE cannot run inside a transaction block. FORCE terminates the
# sessions still holding the database, which is every uvicorn that happens to be running.
psql_admin -c "DROP DATABASE IF EXISTS \"${DB}\" WITH (FORCE)" >/dev/null
psql_admin -c "CREATE DATABASE \"${DB}\" OWNER \"${DB_USER}\"" >/dev/null
say "dropped and recreated ${DB}"

# --exit-on-error because a restore that "mostly worked" is the failure this script exists to catch.
podman exec -i "$CONTAINER" pg_restore -U "$DB_USER" -d "$DB" --exit-on-error <"$FILE" || {
  say "pg_restore failed; ${DB} is now empty or partial, and ${FILE} is still on disk"
  exit 1
}

say "restored ${DB} from ${FILE}"
