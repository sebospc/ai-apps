# What "the stack is up" means, shared by provision.sh and deploy.sh.
#
# Sourced, never executed. The caller has already cd'd into the repository, because the compose file
# mounts ./Caddyfile by a relative path.

# The order is the dependency order in docker-compose.prod.yml: caddy healthy means the chain did.
SMITH_CONTAINERS=(smith-prod-postgres smith-prod-api smith-prod-web smith-prod-caddy)

ENV_FILE=".env.prod"

# Sets RUNTIME and COMPOSE. docker on a host, podman on the laptop that drills this.
stack_init() {
  RUNTIME="${SMITH_CONTAINER_RUNTIME:-docker}"
  command -v "$RUNTIME" >/dev/null 2>&1 || return 1
  # podman 5 prefers docker-compose when it finds one, and Docker Desktop's copy of it calls a
  # credential helper that vanishes with Desktop. Same shim as prod_drill.sh.
  if [ "$RUNTIME" = podman ] && [ -z "${PODMAN_COMPOSE_PROVIDER:-}" ] && command -v podman-compose >/dev/null 2>&1; then
    export PODMAN_COMPOSE_PROVIDER=podman-compose
  fi
  COMPOSE=("$RUNTIME" compose --env-file "$ENV_FILE" -f docker-compose.prod.yml)
  "$RUNTIME" info >/dev/null 2>&1
}

stack_health() {
  "$RUNTIME" inspect --format '{{.State.Health.Status}}' "$1" 2>/dev/null || echo missing
}

stack_all_healthy() {
  local container
  for container in "${SMITH_CONTAINERS[@]}"; do
    [ "$(stack_health "$container")" = healthy ] || return 1
  done
}

# Waits for every service, and on a timeout prints the logs of the one that never came up — the
# question after a failed deploy is always which service and why, so answer it without being asked.
stack_wait_healthy() {
  local deadline=$((SECONDS + ${SMITH_STACK_TIMEOUT:-300})) container status
  for container in "${SMITH_CONTAINERS[@]}"; do
    while :; do
      status="$(stack_health "$container")"
      [ "$status" = healthy ] && break
      if [ $SECONDS -ge $deadline ]; then
        echo "  ${container} never became healthy (last: ${status})" >&2
        "${COMPOSE[@]}" logs --tail 40 "${container#smith-prod-}" >&2 || true
        return 1
      fi
      sleep 3
    done
    echo "  ${container} healthy"
  done
}

# The product as a client sees it: through Caddy, over TLS, on the certificate it is serving.
stack_answers() {
  local site="$1" port="$2" tls="$3" insecure=()
  [ "$tls" = internal ] && insecure=(--insecure)
  curl -fsS --max-time 20 "${insecure[@]}" "https://${site}:${port}/health" >/dev/null
}

stack_certificate_issuer() {
  local site="$1" port="$2"
  openssl s_client -connect "${site}:${port}" -servername "$site" </dev/null 2>/dev/null |
    openssl x509 -noout -issuer 2>/dev/null | sed 's/^issuer=//' || true
}

# An old `sudo docker` leaves root-owned files in the config directory, and every build afterwards
# fails somewhere that never mentions them — it cost this host a deploy. Names them instead.
#
# DOCKER_CONFIG is docker's variable; podman reads its own auth file and ignores it. On the laptop
# this is only ever the detection being exercised.
stack_unreadable_docker_config() {
  local config="${DOCKER_CONFIG:-$HOME/.docker}" entry left=""
  [ -d "$config" ] || return 0
  for entry in "$config"/* "$config"/*/*; do
    [ -e "$entry" ] || continue
    [ -r "$entry" ] && continue
    left="${left}${entry} "
  done
  [ -z "$left" ] || {
    echo "$left"
    return 1
  }
}
