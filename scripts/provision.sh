#!/usr/bin/env bash
# Take a host with nothing on it to a running Smith stack — and, run again, prove the host that has
# users on it is still what this repository says it should be.
#
#   SMITH_SITE=smith.example.com SMITH_TLS=you@example.com \
#   SMITH_SECRET_KEY=... SMITH_DB_PASSWORD=... scripts/provision.sh
#
#   scripts/provision.sh --check    → detect every step, change nothing, print what it would do
#
# Every step detects before it acts and says which of the two it did, so running it against the live
# host is safe. That is not a nicety: the live host is the only host there is to test it against.
#
# What it does not do is listed on every run, with the values it expects. A script that silently
# skips a step is worse than a list, because the list can be followed.
set -euo pipefail

REPO_DIR="${SMITH_REPO_DIR:-/opt/smith}"
REPO_URL="${SMITH_REPO_URL:-https://github.com/sebospc/ai-apps.git}"
REPO_REF="${SMITH_REPO_REF:-main}"
HTTPS_PORT="${SMITH_HTTPS_PORT:-443}"
HTTP_PORT="${SMITH_HTTP_PORT:-80}"

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

changed=0
unchanged=0
say() { echo "provision: $*"; }
did() {
  changed=$((changed + 1))
  echo "  changed  $*"
}
kept() {
  unchanged=$((unchanged + 1))
  echo "  ok       $*"
}
plan() {
  changed=$((changed + 1))
  echo "  would    $*"
}
die() {
  echo "provision: $*" >&2
  exit 1
}

# ---------------------------------------------------------------- the values it has to be given

missing=()
for name in SMITH_SITE SMITH_TLS SMITH_SECRET_KEY SMITH_DB_PASSWORD; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  cat >&2 <<'HELP'
provision: four values have to be given. Nothing here is generated: a secret this script invents is
a secret nobody else has a copy of, and it would end up in whatever log ran it.

  SMITH_SITE         the hostname on the certificate, e.g. smith.example.com
  SMITH_TLS          an email address for Let's Encrypt, or "internal" for a certificate Caddy signs
  SMITH_SECRET_KEY   openssl rand -hex 32   (changing it later signs everyone out)
  SMITH_DB_PASSWORD  openssl rand -hex 16   (only reaches postgres on the run that creates its data)

HELP
  die "not set: ${missing[*]}"
fi

# ---------------------------------------------------------------- what this script cannot do

resolved_ip() {
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$1" 2>/dev/null | awk '{print $1; exit}'
  elif command -v dig >/dev/null 2>&1; then
    dig +short "$1" 2>/dev/null | head -1
  fi
}

public_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
say "not this script's job, and true before a public certificate can be issued:"
echo "  the host itself — a Lightsail instance (or any Ubuntu box) that you are logged into"
echo "  DNS — ${SMITH_SITE} A → ${public_ip:-the public address of this host}"
echo "  firewall — 80/tcp and 443/tcp open to the world; Let's Encrypt connects to 80"

site_ip="$(resolved_ip "$SMITH_SITE" || true)"
if [ "$SMITH_TLS" != internal ] && [ -n "$public_ip" ] && [ -n "$site_ip" ] && [ "$site_ip" != "$public_ip" ]; then
  # Positive evidence of a wrong answer only. A failed issuance costs a Let's Encrypt rate limit,
  # and being unable to resolve here (split horizon, no resolver) is not evidence of anything.
  die "${SMITH_SITE} resolves to ${site_ip}, this host is ${public_ip}. Fix DNS first; asking for a certificate now would burn the rate limit."
fi

# ---------------------------------------------------------------- the container runtime

RUNTIME="${SMITH_CONTAINER_RUNTIME:-docker}"
runtime_answers() { command -v "$RUNTIME" >/dev/null 2>&1 && "$RUNTIME" info >/dev/null 2>&1; }

install_runtime() {
  [ "$RUNTIME" = docker ] || die "${RUNTIME} is not installed here and this script only installs docker."
  [ -r /etc/os-release ] || die "no /etc/os-release, so this is not the Ubuntu host this installs on."
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || die "installs docker with apt on Ubuntu; ${PRETTY_NAME:-this host} is not that. Install a runtime yourself and rerun."
  local sudo=()
  [ "$(id -u)" = 0 ] || sudo=(sudo)
  # ponytail: docker.io and docker-compose-v2 from Ubuntu's own archive ; add download.docker.com as
  # a second apt source if the engine there is ever too old to run this compose file.
  "${sudo[@]}" apt-get update -qq
  "${sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 git curl openssl
  "${sudo[@]}" systemctl enable --now docker
}

if runtime_answers; then
  kept "${RUNTIME} answers: $("$RUNTIME" --version | head -1)"
elif [ "$CHECK" = 1 ]; then
  plan "install docker and docker-compose-v2, and start the docker service"
  say "nothing after this can be checked until there is a runtime; stopping here."
  say "--check: ${changed} would change, ${unchanged} already right"
  exit 0
else
  say "installing docker"
  install_runtime
  if ! runtime_answers; then
    # The group membership is not in this shell's session, and a rerun is the only thing that fixes
    # it. Saying so beats a permission error from the next command.
    [ "$(id -u)" = 0 ] || {
      sudo usermod -aG docker "$(id -un)"
      die "docker is installed. Log out, log back in and run this again: your shell is not in the docker group yet."
    }
    die "docker is installed but not answering. 'systemctl status docker' says why."
  fi
  did "installed docker: $("$RUNTIME" --version | head -1)"
fi

# ---------------------------------------------------------------- the repository

if [ -d "$REPO_DIR/.git" ]; then
  kept "the repository is at ${REPO_DIR}, on $(git -C "$REPO_DIR" rev-parse --short HEAD)"
elif [ "$CHECK" = 1 ]; then
  plan "clone ${REPO_URL} (${REPO_REF}) into ${REPO_DIR}"
else
  [ -e "$REPO_DIR" ] && die "${REPO_DIR} exists and is not a git checkout. Move it or set SMITH_REPO_DIR."
  parent="$(dirname "$REPO_DIR")"
  [ -w "$parent" ] || die "cannot write ${parent}. Run this with sudo, or set SMITH_REPO_DIR to a directory you own."
  git clone --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
  did "cloned ${REPO_URL} into ${REPO_DIR}, on $(git -C "$REPO_DIR" rev-parse --short HEAD)"
fi
if [ ! -d "$REPO_DIR" ]; then
  # Only reachable under --check: without a checkout there is no compose file to read.
  say "--check: ${changed} would change, ${unchanged} already right"
  exit 0
fi

# The compose file mounts ./Caddyfile, so everything below runs from the checkout.
cd "$REPO_DIR"
# shellcheck source=lib/stack.sh
. scripts/lib/stack.sh

# ---------------------------------------------------------------- the environment file

# Secrets are written, never echoed: this file is the only place they land, and it is gitignored.
desired_env() {
  cat <<ENV
# Written by scripts/provision.sh from the environment of whoever ran it. Not in version control.
SMITH_SITE=${SMITH_SITE}
SMITH_TLS=${SMITH_TLS}
SMITH_SECRET_KEY=${SMITH_SECRET_KEY}
SMITH_DB_PASSWORD=${SMITH_DB_PASSWORD}
SMITH_HTTPS_PORT=${HTTPS_PORT}
SMITH_HTTP_PORT=${HTTP_PORT}
ENV
}

if [ -f "$ENV_FILE" ] && [ "$(cat "$ENV_FILE")" = "$(desired_env)" ]; then
  kept "${REPO_DIR}/${ENV_FILE} already holds these values"
elif [ "$CHECK" = 1 ]; then
  plan "$([ -f "$ENV_FILE" ] && echo rewrite || echo write) ${REPO_DIR}/${ENV_FILE} (mode 600, four secrets, none printed)"
else
  # SMITH_DB_PASSWORD only reaches postgres on the run that initialises its data directory, so a
  # rewritten password on a stack that already has a volume leaves the API unable to log in.
  if [ -f "$ENV_FILE" ] && grep -q '^SMITH_DB_PASSWORD=' "$ENV_FILE" && ! grep -qxF "SMITH_DB_PASSWORD=${SMITH_DB_PASSWORD}" "$ENV_FILE"; then
    die "${ENV_FILE} holds a different SMITH_DB_PASSWORD. Postgres kept the old one; change the role's password instead of this file."
  fi
  (
    umask 077
    desired_env >"$ENV_FILE"
  )
  did "wrote ${REPO_DIR}/${ENV_FILE} (mode 600)"
fi

# ---------------------------------------------------------------- the stack

stack_init || die "${RUNTIME} stopped answering."
if stack_all_healthy; then
  kept "all four services are healthy"
elif [ "$CHECK" = 1 ]; then
  for container in "${SMITH_CONTAINERS[@]}"; do
    echo "           ${container}: $(stack_health "$container")"
  done
  plan "build the images and start the stack"
else
  say "building the images and starting the stack"
  [ -f "$ENV_FILE" ] || die "no ${ENV_FILE} to start with."
  unreadable="$(stack_unreadable_docker_config || true)"
  [ -z "$unreadable" ] || die "the build will fail on files it cannot read, and the error it gives will not name them: ${unreadable}
An old 'sudo docker' is how they get there. chown them to $(id -un) or delete them."
  "${COMPOSE[@]}" up -d --build
  stack_wait_healthy || die "the stack did not come up."
  did "the stack is up"
fi

# ---------------------------------------------------------------- the certificate

if [ "$CHECK" = 1 ] && ! stack_all_healthy; then
  plan "let Caddy obtain the certificate for ${SMITH_SITE} ($([ "$SMITH_TLS" = internal ] && echo "its own CA" || echo "Let's Encrypt, account ${SMITH_TLS}"))"
elif stack_answers "$SMITH_SITE" "$HTTPS_PORT" "$SMITH_TLS"; then
  kept "https://${SMITH_SITE}:${HTTPS_PORT}/health answers, certificate issued by $(stack_certificate_issuer "$SMITH_SITE" "$HTTPS_PORT")"
elif [ "$SMITH_TLS" = internal ]; then
  die "the stack is up but https://${SMITH_SITE}:${HTTPS_PORT}/health does not answer. '${RUNTIME} logs smith-prod-caddy' says why."
else
  die "the stack is up but the certificate is not usable yet. Caddy retries; '${RUNTIME} logs smith-prod-caddy' shows the ACME exchange, and DNS or a closed port 80 is the usual reason."
fi

# ---------------------------------------------------------------- the backup schedule

# Both backups this server ever had were taken by hand, minutes before a deploy, because whoever was
# deploying thought of it. The unit runs the dump and then restores that dump into a scratch
# database: a dump nobody has restored is a file, and an incident is a late moment to learn which.
BACKUP_AT="${SMITH_BACKUP_AT:-03:20}"
BACKUP_KEEP="${SMITH_BACKUP_KEEP:-14}"
UNIT_DIR="${SMITH_UNIT_DIR:-/etc/systemd/system}"

desired_service() {
  cat <<UNIT
[Unit]
Description=Smith: dump the database, then restore the dump into a scratch database

[Service]
Type=oneshot
WorkingDirectory=${REPO_DIR}
Environment=SMITH_CONTAINER_RUNTIME=${RUNTIME}
Environment=SMITH_PG_CONTAINER=smith-prod-postgres
Environment=SMITH_BACKUP_KEEP=${BACKUP_KEEP}
ExecStart=${REPO_DIR}/scripts/backup.sh
ExecStart=${REPO_DIR}/scripts/backup_verify.sh
UNIT
}

desired_timer() {
  cat <<UNIT
[Unit]
Description=Smith database backup, nightly

[Timer]
OnCalendar=*-*-* ${BACKUP_AT}:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

if ! command -v systemctl >/dev/null 2>&1; then
  say "not this script's job here, because this host has no systemd. The schedule is two files:"
  echo "  ${UNIT_DIR}/smith-backup.service   oneshot in ${REPO_DIR}: scripts/backup.sh, then scripts/backup_verify.sh"
  echo "  ${UNIT_DIR}/smith-backup.timer     OnCalendar=*-*-* ${BACKUP_AT}:00, Persistent=true"
  echo "  backup.sh keeps the newest ${BACKUP_KEEP} dumps and deletes the rest itself"
else
  # sudo only when it is needed. Root does not want one, and neither does a unit directory this
  # user can already write — a password prompt half way through a provision is a stalled provision.
  as_root() {
    if [ "$(id -u)" = 0 ] || [ -w "$UNIT_DIR" ]; then "$@"; else sudo "$@"; fi
  }
  unit_holds() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }
  timer_enabled="$(systemctl is-enabled smith-backup.timer 2>/dev/null || echo no)"

  if unit_holds "${UNIT_DIR}/smith-backup.service" "$(desired_service)" &&
    unit_holds "${UNIT_DIR}/smith-backup.timer" "$(desired_timer)" &&
    [ "$timer_enabled" = enabled ]; then
    kept "smith-backup.timer is enabled, next $(systemctl show -p NextElapseUSecRealtime --value smith-backup.timer 2>/dev/null || echo unknown)"
  elif [ "$CHECK" = 1 ]; then
    plan "write ${UNIT_DIR}/smith-backup.{service,timer} and enable the timer — ${BACKUP_AT} daily, keeping ${BACKUP_KEEP} dumps"
  else
    desired_service | as_root tee "${UNIT_DIR}/smith-backup.service" >/dev/null
    desired_timer | as_root tee "${UNIT_DIR}/smith-backup.timer" >/dev/null
    as_root systemctl daemon-reload
    as_root systemctl enable --now smith-backup.timer
    did "smith-backup.timer runs at ${BACKUP_AT} daily, keeping ${BACKUP_KEEP} dumps"
  fi
fi

# Nothing on this host pages anybody, and this line is the whole of the monitoring: the age of the
# newest dump, printed by the command an operator already runs to ask whether the host is still
# right. A backup that stopped three weeks ago looks exactly like one that ran last night until
# somebody reads a number.
dump_count="$( { find "${REPO_DIR}/backups" -name '*.dump' -type f 2>/dev/null || true; } | wc -l | tr -d ' ')"
newest_dump="$(ls -t "${REPO_DIR}"/backups/*.dump 2>/dev/null | head -1 || true)"
if [ -z "$newest_dump" ]; then
  echo "           no dump on disk yet; the first one is at ${BACKUP_AT}"
else
  dump_mtime="$(stat -f '%m' "$newest_dump" 2>/dev/null || stat -c '%Y' "$newest_dump")"
  dump_age_h=$((($(date +%s) - dump_mtime) / 3600))
  if [ "$dump_age_h" -gt 48 ]; then
    echo "           STALE the newest of ${dump_count} dumps is ${dump_age_h}h old — the schedule is not running"
    echo "           journalctl -u smith-backup --since -14d   says what it did last"
  else
    echo "           ${dump_count} dumps, newest ${dump_age_h}h old"
  fi
fi

if [ "$CHECK" = 1 ]; then
  say "--check: ${changed} would change, ${unchanged} already right"
  exit 0
fi

say "${changed} changed, ${unchanged} already right — https://${SMITH_SITE}:${HTTPS_PORT}"
[ "$changed" = 0 ] && say "nothing to do: this host already runs what this repository describes."
say "the first lead, if this host has none yet:"
echo "  ${RUNTIME} exec smith-prod-api python scripts/bootstrap.py --email you@co.com --password '...' --project acme"
say "deploying a change afterwards is 'scripts/deploy.sh', which backs the database up first."
say "nothing here pages anyone: 'scripts/provision.sh --check' prints how old the newest dump is."
exit 0
