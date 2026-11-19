#!/usr/bin/env bash
# War Room NOW: stand up a temporary War Room on any Linux server with Docker, use it for an
# incident, export the rooms, and tear the whole thing down.
#
# Nothing else to download first:
#   curl -fsSLO https://raw.githubusercontent.com/tf-anguskong/warroom/main/warroom-now.sh
#   bash warroom-now.sh up
#
#   ./warroom-now.sh up       start (asks for a domain, your email, and optional SMTP)
#   ./warroom-now.sh link     print a fresh one-time admin link
#   ./warroom-now.sh status   what's running and which rooms exist
#   ./warroom-now.sh export   encrypted archive of every room into ./exports/<time>/
#   ./warroom-now.sh import FILE   restore a room archive into this War Room
#   ./warroom-now.sh down     offer an export, then destroy containers AND all data
#
# Answers are remembered in .warroom-now (this script's own memory, not app configuration).
set -euo pipefail
cd "$(dirname "$0")"

STATE=.warroom-now
RAW="${WARROOM_RAW:-https://raw.githubusercontent.com/tf-anguskong/warroom/main}"
# Pin a release with WARROOM_VERSION=1.2.3 (default: latest).
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }
ask() { # ask VAR "Question" [default]
  local __v="$1" __q="$2" __d="${3:-}" __a
  if [ -n "$__d" ]; then read -r -p "$__q [$__d]: " __a; else read -r -p "$__q: " __a; fi
  printf -v "$__v" '%s' "${__a:-$__d}"
}
ask_secret() { local __v="$1" __q="$2" __a; read -r -s -p "$__q: " __a; echo; printf -v "$__v" '%s' "$__a"; }

need_docker() {
  command -v docker >/dev/null || die "Docker isn't installed. See https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin isn't installed (docker compose)."
}

load_state() {
  [ -f "$STATE" ] || die "War Room NOW isn't set up here yet. Run: ./warroom-now.sh up"
  set -a; # shellcheck disable=SC1090
  . "./$STATE"; set +a
}

dc() { docker compose -p warroom-now "$@"; }

# The three files Docker needs next to this script; fetched if you only downloaded the script.
ensure_files() {
  local f
  for f in docker-compose.yml Caddyfile livekit.yaml; do
    if [ ! -f "$f" ]; then
      echo "Downloading $f"
      curl -fsSL "$RAW/$f" -o "$f" || die "couldn't download $f from $RAW"
    fi
  done
}

# Use the published image; build from source only if it can't be pulled and this is a clone.
start_stack() {
  if dc pull --quiet app livekit caddy 2>/dev/null; then
    dc up -d --no-build
  elif [ -f Dockerfile ]; then
    warn "Couldn't pull the War Room image; building it here instead (takes a few minutes)."
    dc up -d --build
  else
    die "Couldn't pull ghcr.io/tf-anguskong/warroom. Check this server's internet access."
  fi
}

wait_healthy() {
  printf 'Waiting for War Room to start'
  for _ in $(seq 1 120); do
    if dc exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then echo ' ready.'; return 0; fi
    printf '.'; sleep 2
  done
  echo; die "War Room didn't start. Look at: docker compose -p warroom-now logs app"
}

admin_link() {
  dc exec -T app node --disable-warning=ExperimentalWarning server/dist/setup-link.js "$@" 120
}

cmd_up() {
  need_docker
  ensure_files
  if [ -f "$STATE" ]; then
    load_state
    bold "Starting War Room NOW at https://$APP_DOMAIN (settings from $STATE)"
  else
    bold "War Room NOW: a temporary War Room for one incident"
    echo "It needs a DNS name pointing at this server (for HTTPS, which browsers require for voice)."
    local ip=""
    ip="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
    local default_domain=""
    [ -n "$ip" ] && default_domain="${ip//./-}.sslip.io"
    [ -n "$default_domain" ] && echo "No DNS name? ${default_domain} works with no setup (sslip.io points it at this server's IP, ${ip})."
    ask APP_DOMAIN "Domain" "$default_domain"
    [ -n "$APP_DOMAIN" ] || die "a domain is required"
    ask WARROOM_ADMIN_EMAIL "Your email (you'll be the admin)" ""
    echo
    echo "Email lets you invite responders and guests with a one-time code sent to them."
    echo "You can skip this and set it later in Admin → Settings → Email."
    ask SMTP_HOST "SMTP server (blank to skip)" ""
    SMTP_PORT=587 SMTP_USER="" SMTP_PASS="" SMTP_FROM=""
    if [ -n "$SMTP_HOST" ]; then
      ask SMTP_PORT "SMTP port (587 STARTTLS, 465 TLS)" "587"
      ask SMTP_USER "SMTP username" ""
      ask_secret SMTP_PASS "SMTP password"
      ask SMTP_FROM "From address" "War Room <${SMTP_USER:-warroom@$APP_DOMAIN}>"
    fi
    umask 077
    {
      printf 'WARROOM_MODE=now\n'
      printf 'APP_DOMAIN=%q\n' "$APP_DOMAIN"
      printf 'WARROOM_ADMIN_EMAIL=%q\n' "$WARROOM_ADMIN_EMAIL"
      printf 'SMTP_HOST=%q\nSMTP_PORT=%q\nSMTP_USER=%q\nSMTP_PASS=%q\nSMTP_FROM=%q\n' "$SMTP_HOST" "$SMTP_PORT" "$SMTP_USER" "$SMTP_PASS" "$SMTP_FROM"
    } > "$STATE"
    load_state
  fi
  start_stack
  wait_healthy
  echo
  bold "War Room is up: https://$APP_DOMAIN"
  local link
  link="$(admin_link --if-no-admin || true)"
  if [ -n "$link" ]; then
    echo "$link"
    echo "Open that link to become the admin, then start a new room or restore one from an archive."
  else
    echo "An admin already exists. Lost access? ./warroom-now.sh link"
  fi
  echo
  echo "Firewall: open TCP 80, 443, 7881 and UDP 50000-50100 to this server."
  warn "This War Room is temporary. Before you destroy the server: ./warroom-now.sh export (or down, which offers it)."
}

cmd_link() { need_docker; load_state; admin_link; }

cmd_status() {
  need_docker; load_state
  dc ps
  echo
  bold "Rooms"
  dc exec -T app node --disable-warning=ExperimentalWarning server/dist/room-cli.js list
}

cmd_export() {
  need_docker; load_state
  local pass pass2 plain="" stamp out
  if [ "${1:-}" = "--plain" ]; then
    warn "Unencrypted export: anyone with the file can read the whole incident."
    plain="--plain"; pass=""
  else
    echo "The archives are encrypted. Keep the passphrase somewhere safe: without it they can't be opened."
    while :; do
      ask_secret pass "Passphrase (at least 10 characters)"
      [ "${#pass}" -ge 10 ] || { warn "Too short."; continue; }
      ask_secret pass2 "Repeat it"
      [ "$pass" = "$pass2" ] && break
      warn "They don't match."
    done
  fi
  stamp="$(date -u +%Y%m%d-%H%M%SZ)"
  out="exports/$stamp"
  mkdir -p "$out"
  WARROOM_EXPORT_PASSPHRASE="$pass" dc exec -T -e WARROOM_EXPORT_PASSPHRASE app \
    node --disable-warning=ExperimentalWarning server/dist/room-cli.js export --all --out "/data/exports/$stamp" $plain
  dc cp "app:/data/exports/$stamp/." "$out/"
  dc exec -T app rm -rf "/data/exports/$stamp"
  echo
  bold "Exported to $(pwd)/$out"
  ls -l "$out"
  echo "Copy that folder off this server before destroying it, e.g.:"
  echo "  scp -r $(whoami)@<this-server>:$(pwd)/$out ."
  echo "Verify a copy with: (cd $out && sha256sum -c SHA256SUMS)"
}

cmd_import() {
  need_docker; load_state
  local file="${1:-}" pass=""
  [ -f "$file" ] || die "give the archive file: ./warroom-now.sh import ROOM.warroom"
  if head -c 17 "$file" | grep -q 'WARROOM-ARCHIVE-1'; then ask_secret pass "Archive passphrase"; fi
  dc cp "$file" app:/data/import.warroom
  WARROOM_EXPORT_PASSPHRASE="$pass" dc exec -T -e WARROOM_EXPORT_PASSPHRASE app \
    node --disable-warning=ExperimentalWarning server/dist/room-cli.js import /data/import.warroom || { dc exec -T app rm -f /data/import.warroom; exit 1; }
  dc exec -T app rm -f /data/import.warroom
}

cmd_down() {
  need_docker; load_state
  local a
  ask a "Export every room before destroying this War Room? (Y/n)" "Y"
  case "$a" in [nN]*) warn "Skipping export." ;; *) cmd_export ;; esac
  echo
  warn "This deletes the containers and ALL War Room data on this server (rooms, files, settings)."
  ask a "Type the domain ($APP_DOMAIN) to confirm" ""
  [ "$a" = "$APP_DOMAIN" ] || die "not confirmed; nothing was deleted"
  dc down --volumes --remove-orphans
  rm -f "$STATE"
  bold "War Room NOW is gone from this server."
  [ -d exports ] && echo "Your exports are still in $(pwd)/exports: copy them off before you destroy the server."
}

case "${1:-}" in
  up) cmd_up ;;
  link) cmd_link ;;
  status) cmd_status ;;
  export) shift; cmd_export "$@" ;;
  import) shift; cmd_import "$@" ;;
  down) cmd_down ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
