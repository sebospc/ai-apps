#!/usr/bin/env bash
# Bring up the production stack and prove it, in a real browser, over HTTPS.
#
#   scripts/prod_drill.sh           → exit 0 when the browser suite passes against the containers
#   scripts/prod_drill.sh --keep    → leave the stack running afterwards
#
# There is no host to deploy to, so this is the closest thing to a deployment we can check: the
# production compose file, a certificate Caddy issued itself, the plugin CLI talking to the API
# through the same door as the browser, and no service published except that door. A compose file
# nobody has driven a browser against is a guess.
set -euo pipefail

cd "$(dirname "$0")/.."

# podman 5 prefers docker-compose when it finds it, and Docker Desktop's copy of it calls a
# credential helper that vanishes with Desktop. podman-compose has no such tie to another product.
if [ -z "${PODMAN_COMPOSE_PROVIDER:-}" ] && command -v podman-compose >/dev/null 2>&1; then
  export PODMAN_COMPOSE_PROVIDER=podman-compose
fi

COMPOSE=(podman compose -f docker-compose.prod.yml)
HTTPS_PORT="${SMITH_HTTPS_PORT:-8443}"
SITE="${SMITH_SITE:-localhost}"
BASE="https://${SITE}:${HTTPS_PORT}"
EMAIL="${SMITH_LEAD_EMAIL:-lead@acme.com}"
PASSWORD="${SMITH_LEAD_PASSWORD:-correct-horse-battery}"
NODE22="${SMITH_NODE22:-$HOME/.nvm/versions/node/v22.23.2/bin}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

say() { echo "prod_drill: $*"; }

# Generated rather than defaulted: a compose file with a fallback secret in it ships that secret.
export SMITH_SECRET_KEY="${SMITH_SECRET_KEY:-$(openssl rand -hex 32)}"
export SMITH_DB_PASSWORD="${SMITH_DB_PASSWORD:-$(openssl rand -hex 16)}"
export SMITH_HTTPS_PORT SMITH_SITE

# Volumes go with it. What is being rehearsed is a deployment onto a host that has nothing yet, and
# the password generated above only reaches postgres on the run that initialises its data directory
# — keeping the volume would mean the second run authenticating with a password nobody set.
# These volumes belong to the `smith-prod` project; the development stack's data is not reachable
# from here.
teardown() {
  if [ "$KEEP" = "1" ]; then
    say "stack left up at ${BASE} — 'podman compose -f docker-compose.prod.yml down -v' when done"
  else
    say "tearing the stack down"
    "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

podman info >/dev/null 2>&1 || { say "podman machine is down; run scripts/ensure_db.sh first"; exit 1; }
[ -x "$NODE22/node" ] || { say "need Node 22 at ${NODE22} (the browser suite uses global WebSocket)"; exit 1; }

say "building and starting the stack"
"${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
"${COMPOSE[@]}" up -d --build

# Caddy depends on web depends on api depends on postgres, each on a health condition, so Caddy
# reporting healthy means the whole chain did.
say "waiting for every service to report healthy"
deadline=$((SECONDS + 300))
for container in smith-prod-postgres smith-prod-api smith-prod-web smith-prod-caddy; do
  while :; do
    status="$(podman inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && break
    [ $SECONDS -lt $deadline ] || { say "${container} never became healthy (last: ${status})"; "${COMPOSE[@]}" logs --tail 40 "${container#smith-prod-}"; exit 1; }
    sleep 3
  done
  say "  ${container} healthy"
done

say "creating the first lead"
podman exec \
  -e "SMITH_DATABASE_URL=postgresql+psycopg://smith:${SMITH_DB_PASSWORD}@postgres:5432/reviewer" \
  smith-prod-api python scripts/bootstrap.py \
  --email "$EMAIL" --password "$PASSWORD" --project smith >/dev/null

# The certificate is real, it is just signed by a CA only this stack knows about. Handing Node that
# CA means the plugin verifies the chain for real instead of being told to skip it.
ca="$(mktemp -t smith-caddy-ca)"
podman cp smith-prod-caddy:/data/caddy/pki/authorities/local/root.crt "$ca"
say "trusting Caddy's CA for the plugin: $(openssl x509 -in "$ca" -noout -subject)"

say "driving ${BASE} in a real browser"
PATH="$NODE22:$PATH" \
NODE_EXTRA_CA_CERTS="$ca" \
SMITH_INSECURE_TLS=1 \
SMITH_WEB_URL="$BASE" \
SMITH_API_URL="$BASE" \
SMITH_LEAD_EMAIL="$EMAIL" \
SMITH_LEAD_PASSWORD="$PASSWORD" \
  node scripts/e2e_browser.mjs

rm -f "$ca"
say "the production stack serves the product over HTTPS"
