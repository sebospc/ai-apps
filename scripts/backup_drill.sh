#!/usr/bin/env bash
# Drive the scheduled backup for real: the dump, what it deletes, and the restore that proves it.
#
#   scripts/backup_drill.sh
#
# The schedule is two files on a host with systemd, which this laptop is not, so what is drilled
# here is everything the timer calls. Every assertion is one that can fail, and the run proves it:
# the verify is shown passing on a good dump and then failing on two bad ones — a dump that no
# longer holds what the database holds, and a truncated file. A check nobody has seen go red is
# indistinguishable from a check that cannot.
#
# It is not destructive. Dumps go to a temporary directory, never backups/; the restore goes into a
# scratch database that backup_verify.sh drops; the one thing it writes to the live database is a
# table named smith_backup_drill, which it drops before it exits.
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${SMITH_PG_CONTAINER:-smith-postgres}"
DB="${SMITH_DB_NAME:-reviewer}"
DB_USER="${SMITH_DB_USER:-smith}"
RUNTIME="${SMITH_CONTAINER_RUNTIME:-podman}"
TMP="$(mktemp -d -t smith-backup-drill)"

failures=0
say() { echo "backup_drill: $*"; }
ok() { echo "  ok   $*"; }
bad() {
  echo "  FAIL $*" >&2
  failures=$((failures + 1))
}

sql() { "$RUNTIME" exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1 -qtAc "$1"; }

teardown() {
  sql "drop table if exists smith_backup_drill" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap teardown EXIT

"$RUNTIME" exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1 || {
  say "postgres is not answering; scripts/ensure_db.sh starts it"
  exit 1
}
rows="$(sql "select count(*) from reviews")"
[ "${rows:-0}" -gt 0 ] || {
  say "no reviews in ${DB}: restoring an empty database proves nothing, so this is not a pass"
  exit 1
}
say "${DB} holds ${rows} reviews"

repo_dumps() { { find backups -name '*.dump' -type f 2>/dev/null || true; } | wc -l | tr -d ' '; }
dumps_before="$(repo_dumps)"

export SMITH_BACKUP_DIR="$TMP"

# ---------------------------------------------------------------- it keeps a bounded number

# Six dumps a fortnight apart, made with touch rather than pg_dump: the pruning reads names and
# mtimes, and six real dumps in the same second would collide on the filename instead.
for day in 01 02 03 04 05 06; do
  : >"${TMP}/${DB}-202601${day}-000000.dump"
  touch -t "202601${day}0000" "${TMP}/${DB}-202601${day}-000000.dump"
done
# Two files the pruning must not touch: another database's dump, and something that is not one.
: >"${TMP}/otherdb-20260101-000000.dump"
: >"${TMP}/notes.txt"

SMITH_BACKUP_KEEP=3 scripts/backup.sh >"${TMP}/backup.log" 2>&1 || {
  bad "backup.sh failed:"
  sed 's/^/       /' "${TMP}/backup.log" >&2
  exit 1
}
DUMP="$(tail -1 "${TMP}/backup.log")"

kept_count="$(find "$TMP" -name "${DB}-*.dump" | wc -l | tr -d ' ')"
[ "$kept_count" = 3 ] && ok "seven dumps, keeping 3: ${kept_count} left" || bad "SMITH_BACKUP_KEEP=3 left ${kept_count} dumps"
[ -f "$DUMP" ] && ok "the one it just took is the one it kept" || bad "the new dump ${DUMP} was deleted by its own pruning"
[ -f "${TMP}/${DB}-20260101-000000.dump" ] && bad "the oldest dump is still there" || ok "the oldest was deleted"
[ -f "${TMP}/otherdb-20260101-000000.dump" ] && ok "another database's dump is untouched" || bad "pruning deleted otherdb-20260101-000000.dump"
[ -f "${TMP}/notes.txt" ] && ok "a file that is not a dump is untouched" || bad "pruning deleted notes.txt"

# ---------------------------------------------------------------- the restore is exercised

if scripts/backup_verify.sh "$DUMP" >"${TMP}/verify.log" 2>&1; then
  ok "$(grep -o 'restores to .*' "${TMP}/verify.log" | head -1)"
else
  bad "the dump it just took does not restore:"
  sed 's/^/       /' "${TMP}/verify.log" >&2
fi
"$RUNTIME" exec "$CONTAINER" psql -U "$DB_USER" -d postgres -qtAc \
  "select count(*) from pg_database where datname = '${DB}_verify'" | grep -qx 0 &&
  ok "the scratch database was dropped" || bad "${DB}_verify is still on the server"

# ---------------------------------------------------------------- and it can say no

# The database gains a table the dump does not have. That is the shape of every real failure here —
# the file restores fine and is no longer the database — and a verify that passes this is decoration.
sql "create table smith_backup_drill (id int)" >/dev/null
sql "insert into smith_backup_drill values (1)" >/dev/null
if scripts/backup_verify.sh "$DUMP" >"${TMP}/stale.log" 2>&1; then
  bad "a dump missing a whole table passed the verify"
else
  grep -q 'smith_backup_drill' "${TMP}/stale.log" &&
    ok "a dump that no longer holds the database fails, naming the table" ||
    bad "it failed, but without naming smith_backup_drill: $(head -2 "${TMP}/stale.log")"
fi
sql "drop table smith_backup_drill" >/dev/null

head -c 2000 "$DUMP" >"${TMP}/truncated.dump"
if scripts/backup_verify.sh "${TMP}/truncated.dump" >"${TMP}/truncated.log" 2>&1; then
  bad "a truncated dump passed the verify"
else
  ok "a truncated dump fails before anything is compared"
fi

# ---------------------------------------------------------------- nothing leaked into the repository

dumps_after="$(repo_dumps)"
[ "$dumps_before" = "$dumps_after" ] &&
  ok "backups/ still holds ${dumps_after} dumps, the drill wrote none of them" ||
  bad "backups/ went from ${dumps_before} dumps to ${dumps_after}"

if [ "$failures" = 0 ]; then
  say "every check passed"
else
  say "${failures} failed"
  exit 1
fi
