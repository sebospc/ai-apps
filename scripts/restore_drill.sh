#!/usr/bin/env bash
# The drill: back up, destroy the database, restore it, and check nothing was lost.
#
#   scripts/restore_drill.sh    → exit 0 when every table holds what it held before, 1 otherwise
#
# A backup nobody has restored is not a backup, so this runs the real scripts against the real
# database rather than a copy. It is destructive on purpose: the dump is taken and verified before
# anything is dropped, and it stays on disk afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${SMITH_PG_CONTAINER:-smith-postgres}"
DB="${SMITH_DB_NAME:-reviewer}"
DB_USER="${SMITH_DB_USER:-smith}"

say() { echo "drill: $*"; }

query() { podman exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -qtAc "$1"; }

# Every table, not a hand-written list: a table added later is covered without anyone remembering.
# Indexes and constraints are counted too, because a restore that brings the rows back but drops a
# foreign key would otherwise pass a row-count check and be discovered much later.
snapshot() {
  local table
  for table in $(query "select tablename from pg_tables where schemaname = 'public' order by 1"); do
    echo "${table}=$(query "select count(*) from \"${table}\"")"
  done
  echo "@indexes=$(query "select count(*) from pg_indexes where schemaname = 'public'")"
  echo "@constraints=$(query "select count(*) from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'")"
  echo "@alembic=$(query "select version_num from alembic_version")"
}

podman exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1 || {
  say "postgres is not answering; run scripts/ensure_db.sh"
  exit 1
}

before="$(snapshot)"
reviews="$(echo "$before" | sed -n 's/^reviews=//p')"
[ "${reviews:-0}" -gt 0 ] || {
  say "no reviews in ${DB}: restoring an empty database proves nothing, so this is not a pass"
  exit 1
}
say "before — ${reviews} reviews, $(echo "$before" | grep -vc '^@') tables, $(echo "$before" | sed -n 's/^@indexes=//p') indexes"

file="$(scripts/backup.sh)"
scripts/restore.sh "$file" --yes

after="$(snapshot)"
if [ "$before" = "$after" ]; then
  say "after  — every table, index and constraint matches. Restored from ${file}"
  exit 0
fi

say "the database is not what it was:"
diff <(echo "$before") <(echo "$after") || true
say "the dump is still at ${file}"
exit 1
