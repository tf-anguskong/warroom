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
#   ./warroom-now.sh firewall change which IP addresses may connect (blank = everyone)
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

# ---------- firewall (UFW) ----------
#
# The IP allowlist lives in UFW. Docker's published ports normally bypass UFW, so the script adds
# the standard "ufw-docker" block to /etc/ufw/after.rules (marked, backed up) which sends Docker's
# traffic through UFW's route rules. Then everything is plain UFW: `ufw status` shows who's allowed,
# and UFW keeps the rules across reboots. All War Room rules carry the comment "warroom-now".
# Port 80 always stays open: Let's Encrypt must reach it for the certificate (it only redirects).

UFW_TAG=warroom-now
AFTER_RULES=/etc/ufw/after.rules

SUDO=""
need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null || die "firewall changes need root; run as root or install sudo"
    SUDO="sudo"
  fi
}

ufw_installed() { command -v ufw >/dev/null 2>&1; }
ufw_active() { ufw_installed && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; }

# The SSH port this session uses (so turning UFW on can't lock you out).
ssh_port() { local p="${SSH_CONNECTION:-}"; p="${p##* }"; [[ "$p" =~ ^[0-9]+$ ]] && echo "$p" || echo 22; }

# Make UFW govern Docker's published ports (ufw-docker). Idempotent.
ufw_docker_link() {
  $SUDO grep -q "# BEGIN UFW AND DOCKER" "$AFTER_RULES" && return 0
  $SUDO cp "$AFTER_RULES" "$AFTER_RULES.warroom-now.bak"
  $SUDO tee -a "$AFTER_RULES" >/dev/null <<'EOF'

# BEGIN UFW AND DOCKER (added by warroom-now.sh: UFW rules now apply to Docker's published ports)
*filter
:ufw-user-forward - [0:0]
:ufw-docker-logging-deny - [0:0]
:DOCKER-USER - [0:0]
-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
-A DOCKER-USER -j ufw-user-forward

-A DOCKER-USER -j RETURN -s 10.0.0.0/8
-A DOCKER-USER -j RETURN -s 172.16.0.0/12
-A DOCKER-USER -j RETURN -s 192.168.0.0/16

-A DOCKER-USER -p udp -m udp --sport 53 --dport 1024:65535 -j RETURN

-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -d 172.16.0.0/12
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 192.168.0.0/16
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 10.0.0.0/8
-A DOCKER-USER -j ufw-docker-logging-deny -p udp -m udp --dport 0:32767 -d 172.16.0.0/12

-A DOCKER-USER -j RETURN

-A ufw-docker-logging-deny -m limit --limit 3/min --limit-burst 10 -j LOG --log-prefix "[UFW DOCKER BLOCK] "
-A ufw-docker-logging-deny -j DROP

COMMIT
# END UFW AND DOCKER
EOF
}

# Undo ufw_docker_link (only the block this script added).
ufw_docker_unlink() {
  $SUDO grep -q "# BEGIN UFW AND DOCKER (added by warroom-now.sh" "$AFTER_RULES" 2>/dev/null || return 0
  $SUDO sed -i '/^# BEGIN UFW AND DOCKER (added by warroom-now.sh/,/^# END UFW AND DOCKER/d' "$AFTER_RULES"
  # Drop the blank line left before the block.
  $SUDO sed -i -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$AFTER_RULES"
}

# Delete every rule tagged warroom-now (highest number first so numbers don't shift).
ufw_clear_rules() {
  local n
  for n in $({ $SUDO ufw status numbered 2>/dev/null || true; } | { grep "# $UFW_TAG\$" || true; } | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn); do
    $SUDO ufw --force delete "$n" >/dev/null
  done
}

# One "from" for both the host (INPUT, e.g. IPv6 via docker-proxy) and Docker's forwarded traffic.
ufw_allow_from() { # ufw_allow_from SRC
  local src="$1"
  $SUDO ufw allow from "$src" to any port 443 proto tcp comment "$UFW_TAG" >/dev/null
  $SUDO ufw allow from "$src" to any port 7881 proto tcp comment "$UFW_TAG" >/dev/null
  $SUDO ufw allow from "$src" to any port 50000:50100 proto udp comment "$UFW_TAG" >/dev/null
  $SUDO ufw route allow proto tcp from "$src" to any port 443 comment "$UFW_TAG" >/dev/null
  $SUDO ufw route allow proto tcp from "$src" to any port 7881 comment "$UFW_TAG" >/dev/null
  $SUDO ufw route allow proto udp from "$src" to any port 50000:50100 comment "$UFW_TAG" >/dev/null
}

# Write War Room's UFW rules from ALLOW_IPS (blank = everyone). Safe to run repeatedly.
fw_apply() {
  local list="${ALLOW_IPS:-}" e
  ufw_active || { warn "UFW isn't active; War Room's firewall rules were not applied (run ./warroom-now.sh firewall)."; return 1; }
  legacy_cleanup
  ufw_docker_link
  ufw_clear_rules
  # Certificates: port 80 open to everyone.
  $SUDO ufw allow 80/tcp comment "$UFW_TAG" >/dev/null
  $SUDO ufw route allow proto tcp from any to any port 80 comment "$UFW_TAG" >/dev/null
  if [ -z "$list" ]; then
    ufw_allow_from any
  else
    for e in $list; do ufw_allow_from "$e"; done
    # The ufw-docker block only blocks UDP below 32768; close the media range to everyone else.
    $SUDO ufw route deny proto udp from any to any port 50000:50100 comment "$UFW_TAG" >/dev/null
  fi
  $SUDO ufw reload >/dev/null
  if [ -n "$list" ]; then echo "UFW: only these addresses can reach War Room (HTTPS and voice): $list"
  else echo "UFW: War Room's ports are open to everyone (they still need an invite and a code to get in)."; fi
}

# Earlier versions of this script used their own DOCKER-USER chain and a systemd unit; remove them.
legacy_cleanup() {
  local ipt rule
  for ipt in iptables ip6tables; do
    command -v "$ipt" >/dev/null 2>&1 || continue
    { $SUDO "$ipt" -S DOCKER-USER 2>/dev/null || true; } | { grep -- '--comment warroom-now' || true; } | { grep -- '-j WARROOM-NOW' || true; } |
      sed 's/^-A /-D /' | while read -r rule; do eval "$SUDO $ipt $rule" || true; done
    $SUDO "$ipt" -F WARROOM-NOW 2>/dev/null || true
    $SUDO "$ipt" -X WARROOM-NOW 2>/dev/null || true
  done
  if [ -f /etc/systemd/system/warroom-now-firewall.service ]; then
    $SUDO systemctl disable -q warroom-now-firewall.service 2>/dev/null || true
    $SUDO rm -f /etc/systemd/system/warroom-now-firewall.service
    $SUDO systemctl daemon-reload 2>/dev/null || true
  fi
}

# Remove everything War Room added to UFW (rules and the Docker link). Leaves UFW itself on.
fw_remove() {
  ufw_installed || return 0
  legacy_cleanup
  ufw_clear_rules
  ufw_docker_unlink
  ufw_active && $SUDO ufw reload >/dev/null || true
}

# Normalise "1.2.3.4, 10.0.0.0/8 ,2001:db8::/32" → space-separated list; dies on anything invalid.
parse_allowlist() {
  local raw="$1" out="" e
  IFS=', ' read -r -a items <<< "$raw"
  for e in "${items[@]}"; do
    [ -n "$e" ] || continue
    if [[ "$e" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; then
      local o; for o in $(echo "${e%%/*}" | tr . ' '); do [ "$o" -le 255 ] || die "not a valid IPv4 address: $e"; done
    elif [[ "$e" =~ ^[0-9a-fA-F:]+:[0-9a-fA-F:]*(/([0-9]{1,2}|1[01][0-9]|12[0-8]))?$ ]]; then :
    else die "not an IP address or CIDR range: $e"; fi
    out="$out $e"
  done
  echo "${out# }"
}

save_state_var() { # save_state_var NAME VALUE
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" "$STATE" > "$tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$STATE"; rm -f "$tmp"
}

# Interactive: make sure UFW is on, ask for allowed IPs, save and apply.
ask_firewall() {
  need_root
  echo
  bold "Firewall (UFW)"
  local a raw me="" port
  if ! ufw_installed; then
    if command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
      warn "This server uses firewalld, not UFW. Allow TCP 80, 443, 7881 and UDP 50000-50100 there yourself."
      warn "(Docker's published ports bypass firewalld's normal rules; restrict by IP in your cloud firewall instead.)"
      return 0
    fi
    ask a "UFW isn't installed. Install it to manage who can connect? (Y/n)" "Y"
    case "$a" in [nN]*) warn "No host firewall: allow the ports in your cloud firewall instead."; return 0 ;; esac
    if command -v apt-get >/dev/null; then $SUDO apt-get install -y -qq ufw >/dev/null || die "couldn't install ufw"
    elif command -v dnf >/dev/null; then $SUDO dnf install -y -q ufw >/dev/null || die "couldn't install ufw"
    else die "install ufw with your package manager, then run ./warroom-now.sh firewall"; fi
  fi
  if ! ufw_active; then
    port="$(ssh_port)"
    ask a "UFW is off. Turn it on? SSH (port $port) stays allowed so you won't be locked out. (Y/n)" "Y"
    case "$a" in [nN]*) warn "UFW stays off: allow the ports in your cloud firewall instead."; return 0 ;; esac
    $SUDO ufw allow "$port/tcp" comment "ssh (kept by warroom-now)" >/dev/null
    $SUDO ufw --force enable >/dev/null
    echo "UFW is on (incoming blocked by default; SSH on port $port allowed)."
  fi
  echo
  echo "Restrict who can connect? Enter IP addresses or CIDR ranges separated by commas,"
  echo "for example 203.0.113.7, 198.51.100.0/24. Leave blank to allow everyone."
  echo "Everyone who joins (including guests) needs to come from one of these addresses."
  [ -n "${SSH_CLIENT:-}" ] && me="${SSH_CLIENT%% *}" && echo "You're connected from $me; include it if you'll use War Room from here."
  [ -n "${ALLOW_IPS:-}" ] && echo "Press Enter to keep the current list, or type all to allow everyone again."
  ask raw "Allowed addresses" "${ALLOW_IPS:-}"
  case "$(echo "$raw" | tr '[:upper:]' '[:lower:]' | tr -d ' ')" in all | any | everyone | '*') raw="" ;; esac
  local parsed
  parsed="$(parse_allowlist "$raw")" || die "nothing was changed; run ./warroom-now.sh firewall to try again"
  ALLOW_IPS="$parsed"
  save_state_var ALLOW_IPS "$ALLOW_IPS"
  fw_apply
  warn "Also allow the same ports in your cloud provider's firewall / security group; this script can't change that."
}

cmd_firewall() {
  need_docker; load_state
  ask_firewall
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
    ask_firewall
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
  if [ -n "${ALLOW_IPS:-}" ]; then echo "Allowed addresses (UFW): $ALLOW_IPS  (change with ./warroom-now.sh firewall)"; fi
  echo "Cloud firewall / security group: allow TCP 80, 443, 7881 and UDP 50000-50100 to this server."
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
  if ufw_installed; then
    need_root
    ask a "Remove War Room's rules from UFW? (UFW stays on; SSH stays allowed) (Y/n)" "Y"
    case "$a" in [nN]*) ;; *) fw_remove; echo "Removed War Room's UFW rules." ;; esac
  fi
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
  firewall) cmd_firewall ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
