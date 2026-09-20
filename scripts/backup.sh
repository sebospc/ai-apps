#!/usr/bin/env bash
# Dump the reviewer database to a timestamped file, and prove the file is a readable archive.
#
#   scripts/backup.sh                → writes backups/reviewer-20260821-140000.dump
#   SMITH_BACKUP_DIR=/mnt/x scripts/backup.sh
#   SMITH_BACKUP_KEEP=30 scripts/backup.sh   → keeps 30 instead of 14; 0 keeps everything
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
# A disk that fills is an outage the backup caused, so the number of dumps is bounded by default.
KEEP="${SMITH_BACKUP_KEEP:-14}"
# podman on the laptop, docker on the host: the container is the same, the command that reaches it is not.
RUNTIME="${SMITH_CONTAINER_RUNTIME:-podman}"

# Progress goes to stderr so the only thing on stdout is the path, which callers capture.
say() { echo "backup: $*" >&2; }

"$RUNTIME" exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1 || {
  say "postgres is not answering in container ${CONTAINER}; run scripts/ensure_db.sh"
  exit 1
}

mkdir -p "$DIR"
FILE="${DIR}/${DB}-$(date +%Y%m%d-%H%M%S).dump"

"$RUNTIME" exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" --format=custom >"$FILE" || {
  say "pg_dump failed"
  rm -f "$FILE"
  exit 1
}

# A dump nobody can read is not a backup. Reading its table of contents costs milliseconds here and
# catches a truncated or empty file now, instead of during a restore when the database is gone.
"$RUNTIME" exec -i "$CONTAINER" pg_restore --list <"$FILE" >/dev/null 2>&1 || {
  say "the file is not a readable archive, refusing to keep it"
  rm -f "$FILE"
  exit 1
}

say "$(wc -c <"$FILE" | tr -d ' ') bytes → ${FILE}"

# Pruning runs only after the new dump has been read back, so a failing backup can never be the
# thing that deletes the last good one. The glob is this database's dumps and nothing else.
if [ "$KEEP" -gt 0 ]; then
  pruned=0
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$old"
    pruned=$((pruned + 1))
  done <<<"$(ls -t "${DIR}/${DB}"-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))")"
  [ "$pruned" = 0 ] || say "kept the newest ${KEEP}, deleted ${pruned} older"
fi

echo "$FILE"
