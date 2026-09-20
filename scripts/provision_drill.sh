#!/usr/bin/env bash
# Drive scripts/provision.sh and scripts/deploy.sh for real, on this laptop.
#
#   scripts/provision_drill.sh
#
# Three things stand in for the host: podman for docker, a clone of this repository for GitHub, and
# Caddy's own CA for Let's Encrypt. Everything else is the script an operator would run, including
# the build, the health wait and the HTTPS check.
#
# Each assertion is one that can fail, and the run proves it: the idempotent second pass is checked
# against a third pass with a changed secret, which the script refuses; the "no secret is printed"
# check greps for values the drill generated itself, so it would see them if they leaked.
#
# It cannot check what only a host has: apt installing docker, a public certificate, port 443, or
# DNS. Those are listed by provision.sh on every run instead of being done silently.
#
# It starts from nothing, and it removes the stack's containers and volumes itself rather than
# through compose: a `compose down` needs the environment file the drill is about to write, and it
# picks whichever compose provider podman finds. The first version used it, left the postgres volume
# behind, and the next run failed on a password the volume already had.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
TMP="$(mktemp -d -t smith-provision-drill)"

export SMITH_CONTAINER_RUNTIME=podman
export SMITH_REPO_DIR="$TMP/smith"
export SMITH_REPO_URL="$REPO"
export SMITH_SITE=localhost
export SMITH_TLS=internal
export SMITH_HTTPS_PORT=8443
export SMITH_HTTP_PORT=8080
SECRET_KEY="$(openssl rand -hex 32)"
DB_PASSWORD="$(openssl rand -hex 16)"

failures=0
say() { echo "provision_drill: $*"; }
ok() { echo "  ok   $*"; }
bad() {
  echo "  FAIL $*" >&2
  failures=$((failures + 1))
}
holds() { # description, pattern, log
  if grep -qF -- "$2" "$3"; then ok "$1"; else
    bad "$1 — no '$2' in $(basename "$3"):"
    sed 's/^/       /' "$3" >&2
  fi
}

# shellcheck source=lib/stack.sh
. scripts/lib/stack.sh

# Containers, then the pod compose put them in, then the volumes. In any other order podman refuses:
# a volume with a container on it takes the container's dependents with it and gives up half way.
wipe_stack() {
  podman rm -f "${SMITH_CONTAINERS[@]}" >/dev/null 2>&1 || true
  podman pod rm -f pod_smith-prod >/dev/null 2>&1 || true
  podman volume rm -f smith-prod_pgdata smith-prod_caddy-data >/dev/null 2>&1 || true
  local left
  left="$( (podman ps -a --format '{{.Names}}' | grep '^smith-prod' || true; podman volume ls --format '{{.Name}}' | grep '^smith-prod_' || true) | tr '\n' ' ')"
  [ -z "$left" ] || {
    say "these are still here and the drill cannot start from nothing: ${left}"
    return 1
  }
}

teardown() {
  say "tearing the drilled stack down"
  wipe_stack || true
  rm -rf "$TMP"
}
trap teardown EXIT

podman info >/dev/null 2>&1 || {
  say "podman is down; scripts/ensure_db.sh starts the machine"
  exit 1
}
# provision.sh and deploy.sh are run from this working tree, so an edit to either is drilled
# immediately. Everything they read after the clone — the compose file, the Caddyfile, lib/stack.sh —
# comes from the clone, which is HEAD.
if [ -n "$(git status --porcelain -- Caddyfile docker-compose.prod.yml Dockerfile scripts/lib)" ]; then
  say "note: the clone is of HEAD, so uncommitted changes to the compose file, the Caddyfile or scripts/lib are NOT what this drills"
fi

# The stack is one project name, so a drill and prod_drill.sh cannot both hold port 8443.
wipe_stack || exit 1

provision() { # name of the log, then the arguments
  local log="$TMP/$1.log"
  shift
  set +e
  SMITH_SECRET_KEY="$SECRET_KEY" SMITH_DB_PASSWORD="$DB_PASSWORD" "$REPO/scripts/provision.sh" "$@" >"$log" 2>&1
  local code=$?
  set -e
  echo "$code" >"$TMP/$(basename "$log" .log).code"
}
code_of() { cat "$TMP/$1.code"; }

# ---------------------------------------------------------------- it refuses to invent a secret

set +e
env -u SMITH_SITE -u SMITH_TLS -u SMITH_SECRET_KEY -u SMITH_DB_PASSWORD \
  "$REPO/scripts/provision.sh" >"$TMP/missing.log" 2>&1
missing_code=$?
set -e
[ "$missing_code" = 1 ] && ok "refuses without the four values" || bad "exited ${missing_code} with nothing set"
for name in SMITH_SITE SMITH_TLS SMITH_SECRET_KEY SMITH_DB_PASSWORD; do
  holds "names ${name}" "$name" "$TMP/missing.log"
done

# ---------------------------------------------------------------- --check changes nothing

provision check --check
[ "$(code_of check)" = 0 ] && ok "--check exits 0" || bad "--check exited $(code_of check)"
holds "--check plans the clone" "would    clone" "$TMP/check.log"
holds "--check names what it cannot do" "firewall — 80/tcp and 443/tcp" "$TMP/check.log"
[ -e "$SMITH_REPO_DIR" ] && bad "--check created ${SMITH_REPO_DIR}" || ok "--check left the host alone"

# ---------------------------------------------------------------- the real thing

say "provisioning (builds two images the first time)"
provision first
[ "$(code_of first)" = 0 ] || {
  bad "the first run exited $(code_of first)"
  sed 's/^/       /' "$TMP/first.log" >&2
  exit 1
}
holds "clones the repository" "changed  cloned" "$TMP/first.log"
holds "writes the environment file" "changed  wrote" "$TMP/first.log"
holds "brings the stack up" "changed  the stack is up" "$TMP/first.log"
holds "reads the certificate back" "certificate issued by" "$TMP/first.log"

mode="$(stat -f '%Lp' "$SMITH_REPO_DIR/.env.prod" 2>/dev/null || stat -c '%a' "$SMITH_REPO_DIR/.env.prod")"
[ "$mode" = 600 ] && ok ".env.prod is mode 600" || bad ".env.prod is mode ${mode}"
curl -fsS --insecure --max-time 20 "https://localhost:${SMITH_HTTPS_PORT}/health" >/dev/null &&
  ok "the product answers over HTTPS" || bad "https://localhost:${SMITH_HTTPS_PORT}/health does not answer"

# ---------------------------------------------------------------- a second run changes nothing

before="$(stat -f '%m' "$SMITH_REPO_DIR/.env.prod" 2>/dev/null || stat -c '%Y' "$SMITH_REPO_DIR/.env.prod")"
provision second
[ "$(code_of second)" = 0 ] || bad "the second run exited $(code_of second)"
holds "the second run changes nothing" "0 changed" "$TMP/second.log"
holds "and says so" "nothing to do" "$TMP/second.log"
after="$(stat -f '%m' "$SMITH_REPO_DIR/.env.prod" 2>/dev/null || stat -c '%Y' "$SMITH_REPO_DIR/.env.prod")"
[ "$before" = "$after" ] && ok ".env.prod was not rewritten" || bad ".env.prod was rewritten on a run that reported no change"

# That the second run finds no work is only worth something if the comparison can find work. A
# different database password is the one difference that must never be written over a live volume.
set +e
SMITH_SECRET_KEY="$SECRET_KEY" SMITH_DB_PASSWORD=0000000000000000 \
  "$REPO/scripts/provision.sh" >"$TMP/rotated.log" 2>&1
rotated_code=$?
set -e
[ "$rotated_code" = 1 ] && ok "a changed database password is refused, not written" || bad "a changed database password exited ${rotated_code}"
holds "and says why" "Postgres kept the old one" "$TMP/rotated.log"

# ---------------------------------------------------------------- deploying to it

say "deploying to the stack it just started"
set +e
(cd "$SMITH_REPO_DIR" && SMITH_CONTAINER_RUNTIME=podman scripts/deploy.sh HEAD) >"$TMP/deploy.log" 2>&1
deploy_code=$?
set -e
[ "$deploy_code" = 0 ] || {
  bad "deploy exited ${deploy_code}"
  sed 's/^/       /' "$TMP/deploy.log" >&2
}
holds "deploy takes a backup first" "backing the database up before anything changes" "$TMP/deploy.log"
holds "and the dump is real" ".dump" "$TMP/deploy.log"
holds "deploy ends on the running product" "serves" "$TMP/deploy.log"
dumps="$(ls "$SMITH_REPO_DIR"/backups/*.dump 2>/dev/null | wc -l | tr -d ' ')"
[ "$dumps" -ge 1 ] && ok "the dump is on disk (${dumps})" || bad "no dump was written"

# The other cost this host paid: files under the docker config directory that the build cannot read.
# Mode 000 stands in for root-owned, which is how they got there and is not reproducible without sudo.
cfg="$TMP/dockercfg"
mkdir -p "$cfg"
: >"$cfg/config.json"
chmod 000 "$cfg/config.json"
set +e
(cd "$SMITH_REPO_DIR" && SMITH_CONTAINER_RUNTIME=podman DOCKER_CONFIG="$cfg" scripts/deploy.sh HEAD) >"$TMP/unreadable.log" 2>&1
unreadable_code=$?
set -e
[ "$unreadable_code" = 1 ] && ok "a docker config it cannot read stops the deploy" || bad "deployed with an unreadable docker config (exit ${unreadable_code})"
holds "and names the file" "config.json" "$TMP/unreadable.log"
chmod 644 "$cfg/config.json"

echo "a hand edit" >>"$SMITH_REPO_DIR/Caddyfile"
set +e
(cd "$SMITH_REPO_DIR" && SMITH_CONTAINER_RUNTIME=podman scripts/deploy.sh HEAD) >"$TMP/dirty.log" 2>&1
dirty_code=$?
set -e
[ "$dirty_code" = 1 ] && ok "deploy refuses a checkout edited by hand" || bad "deploy ran over a hand-edited Caddyfile (exit ${dirty_code})"
holds "and names the file" "Caddyfile" "$TMP/dirty.log"
holds "with the backup already taken" "Nothing was deployed" "$TMP/dirty.log"

# ---------------------------------------------------------------- no secret reaches a log

leaked=0
for log in "$TMP"/*.log; do
  grep -qF -- "$SECRET_KEY" "$log" && {
    bad "SMITH_SECRET_KEY is printed in $(basename "$log")"
    leaked=1
  }
  grep -qF -- "$DB_PASSWORD" "$log" && {
    bad "SMITH_DB_PASSWORD is printed in $(basename "$log")"
    leaked=1
  }
done
[ "$leaked" = 0 ] && ok "no secret appears in any output"

if [ "$failures" = 0 ]; then
  say "every check passed"
else
  say "${failures} failed"
  exit 1
fi
