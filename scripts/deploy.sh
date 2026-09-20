#!/usr/bin/env bash
# Deploy to the host this runs on. One command, and the database is backed up before anything moves.
#
#   scripts/deploy.sh          → whatever is on origin/main
#   scripts/deploy.sh v0.4.0   → a tag, a branch or a sha
#
# It refuses on a dirty checkout rather than resetting over it. Files on this host have been edited
# by hand before — the Caddyfile is the one that matters — and a deploy that silently discards them
# is how a route disappears from production without anything going red.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/stack.sh
. scripts/lib/stack.sh

REF="${1:-origin/main}"
say() { echo "deploy: $*"; }
die() {
  echo "deploy: $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || die "no ${ENV_FILE} here. This host was never provisioned: scripts/provision.sh does that."
stack_init || die "no container runtime answering. Set SMITH_CONTAINER_RUNTIME if it is not docker."

unreadable="$(stack_unreadable_docker_config || true)"
[ -z "$unreadable" ] || die "the build will fail on files it cannot read, and the error it gives will not name them: ${unreadable}
An old 'sudo docker' is how they get there. chown them to $(id -un) or delete them. Nothing was deployed."

env_value() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }
SITE="$(env_value SMITH_SITE)"
TLS="$(env_value SMITH_TLS)"
HTTPS_PORT="$(env_value SMITH_HTTPS_PORT)"
HTTPS_PORT="${HTTPS_PORT:-443}"

# ---------------------------------------------------------------- back up first

[ "$(stack_health smith-prod-postgres)" = healthy ] ||
  die "postgres is not healthy, so there is nothing to take a backup from. Bring the stack up first: scripts/provision.sh"

say "backing the database up before anything changes"
DUMP="$(SMITH_CONTAINER_RUNTIME="$RUNTIME" SMITH_PG_CONTAINER=smith-prod-postgres scripts/backup.sh)" ||
  die "the backup failed, so nothing was deployed."
say "  ${DUMP}"

# ---------------------------------------------------------------- the code

dirty="$(git status --porcelain)"
[ -z "$dirty" ] || die "this checkout has changes that are not in git:
${dirty}
Commit them, or copy them somewhere, then run this again. Nothing was deployed and the backup above stands."

BEFORE="$(git rev-parse --short HEAD)"
git fetch --quiet origin
git checkout --quiet --detach "$REF"
AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  say "already on ${AFTER}; rebuilding it anyway, since that is what was asked for"
else
  say "${BEFORE} → ${AFTER}"
  git --no-pager log --oneline "${BEFORE}..${AFTER}" | head -20
fi

# ---------------------------------------------------------------- the stack

say "building and restarting"
"${COMPOSE[@]}" up -d --build
stack_wait_healthy || die "the stack did not come back up on ${AFTER}.
Roll back with:  git checkout ${BEFORE} && scripts/deploy.sh ${BEFORE}
The database is untouched, and ${DUMP} is the copy taken before this ran."

if stack_answers "$SITE" "$HTTPS_PORT" "$TLS"; then
  say "https://${SITE}:${HTTPS_PORT} serves ${AFTER}"
else
  die "every service is healthy but https://${SITE}:${HTTPS_PORT}/health does not answer — that is Caddy or the certificate, not the build.
'${RUNTIME} logs smith-prod-caddy' says which. Roll back with: scripts/deploy.sh ${BEFORE}"
fi
