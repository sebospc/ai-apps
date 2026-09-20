#!/usr/bin/env bash
# Restore the newest dump into a scratch database and count its rows against the live one.
#
#   scripts/backup_verify.sh                     → the newest file in backups/
#   scripts/backup_verify.sh backups/x.dump      → that one
#
# backup.sh already proves a dump is a readable archive. That is a property of the file. This is the
# only thing that says the file still holds the database, and it is the difference between a backup
# and a recovery plan.
#
# The live database is never written to: the restore goes into a scratch database this script
# creates and drops. Every table is compared, plus indexes and constraints, because a restore that
# brings the rows back without a foreign key passes a row count and is found much later.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${SMITH_PG_CONTAINER:-smith-postgres}"
DB="${SMITH_DB_NAME:-reviewer}"
DB_USER="${SMITH_DB_USER:-smith}"
DIR="${SMITH_BACKUP_DIR:-backups}"
RUNTIME="${SMITH_CONTAINER_RUNTIME:-podman}"
SCRATCH="${DB}_verify"

say() { echo "verify: $*"; }

# Plain mktemp: the -t form is macOS-only, and this one runs on the host every night.
ERRORS="$(mktemp)"
trap 'rm -f "$ERRORS"' EXIT

FILE="${1:-}"
if [ -z "$FILE" ]; then
  FILE="$(ls -t "${DIR}"/*.dump 2>/dev/null | head -1 || true)"
  [ -n "$FILE" ] || {
    say "no dump given and none found in ${DIR}/ — nothing has been backed up here"
    exit 1
  }
fi
[ -f "$FILE" ] || {
  say "no such file: ${FILE}"
  exit 1
}

"$RUNTIME" exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1 || {
  say "postgres is not answering in container ${CONTAINER}"
  exit 1
}

psql_admin() { "$RUNTIME" exec "$CONTAINER" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }
drop_scratch() { psql_admin -c "DROP DATABASE IF EXISTS \"${SCRATCH}\" WITH (FORCE)" >/dev/null 2>&1 || true; }
trap 'drop_scratch; rm -f "$ERRORS"' EXIT

# One statement per table would be a round trip per table. This is one query that reports every
# table's count, so the two sides are read the same way and cannot drift in how they were counted.
counts() { # database
  "$RUNTIME" exec -i "$CONTAINER" psql -U "$DB_USER" -d "$1" -qtA -v ON_ERROR_STOP=1 <<'SQL'
select string_agg(line, e'\n' order by line) from (
  select format('%s=%s', tablename,
           (xpath('/row/c/text()',
                  query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename),
                               false, true, '')))[1]::text) as line
    from pg_tables where schemaname = 'public'
  union all
  select format('@indexes=%s', count(*)) from pg_indexes where schemaname = 'public'
  union all
  select format('@constraints=%s', count(*)) from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
) rows;
SQL
}

live="$(counts "$DB")"
[ -n "$live" ] || {
  say "${DB} has no tables at all, so a restore of it proves nothing"
  exit 1
}

drop_scratch
psql_admin -c "CREATE DATABASE \"${SCRATCH}\" OWNER \"${DB_USER}\"" >/dev/null

# --exit-on-error because a restore that "mostly worked" is the failure this script exists to find.
if ! "$RUNTIME" exec -i "$CONTAINER" pg_restore -U "$DB_USER" -d "$SCRATCH" --exit-on-error <"$FILE" >/dev/null 2>"$ERRORS"; then
  say "pg_restore refused ${FILE} — this dump would not restore the database:"
  sed 's/^/  /' "$ERRORS" >&2
  exit 1
fi

restored="$(counts "$SCRATCH")"

if [ "$live" = "$restored" ]; then
  rows="$(echo "$live" | grep -v '^@' | cut -d= -f2 | awk '{total += $1} END {print total + 0}')"
  say "${FILE} restores to ${rows} rows in $(echo "$live" | grep -vc '^@') tables, matching ${DB}"
  exit 0
fi

say "the dump does not hold what ${DB} holds:"
diff <(echo "$live") <(echo "$restored") | sed 's/^/  /' >&2 || true
say "left is ${DB} now, right is ${FILE} restored."
say "a write between the dump and this count reads the same way — rerun to tell them apart."
exit 1
