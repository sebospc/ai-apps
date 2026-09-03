#!/usr/bin/env bash
# Dump the reviewer database to a timestamped file, and prove the file is a readable archive.
#
#   scripts/backup.sh                → writes backups/reviewer-20260821-140000.dump
#   SMITH_BACKUP_DIR=/mnt/x scripts/backup.sh
#
# The dump runs inside the container, so no postgres client is needed on the host. Custom format
# because it is already compressed and pg_restore reads it; a plain .sql file would need psql and
# would not survive a partial write as visibly.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${SMITH_PG_CONTAINER:-smith-postgres}"
DB="${SMITH_DB_NAME:-reviewer}"
DB_USER="${SMITH_DB_USER:-smith}"
DIR="${SMITH_BACKUP_DIR:-backups}"

# Progress goes to stderr so the only thing on stdout is the path, which callers capture.
say() { echo "backup: $*" >&2; }

podman exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1 || {
  say "postgres is not answering in container ${CONTAINER}; run scripts/ensure_db.sh"
  exit 1
}

mkdir -p "$DIR"
FILE="${DIR}/${DB}-$(date +%Y%m%d-%H%M%S).dump"

podman exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" --format=custom >"$FILE" || {
  say "pg_dump failed"
  rm -f "$FILE"
  exit 1
}

# A dump nobody can read is not a backup. Reading its table of contents costs milliseconds here and
# catches a truncated or empty file now, instead of during a restore when the database is gone.
podman exec -i "$CONTAINER" pg_restore --list <"$FILE" >/dev/null 2>&1 || {
  say "the file is not a readable archive, refusing to keep it"
  rm -f "$FILE"
  exit 1
}

say "$(wc -c <"$FILE" | tr -d ' ') bytes → ${FILE}"
echo "$FILE"
