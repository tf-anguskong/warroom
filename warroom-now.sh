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

# ---------- firewall ----------
#
# Two separate things:
#  1. Host firewall (ufw / firewalld): opened for War Room's ports if it's active.
#  2. IP allowlist: Docker's published ports bypass ufw and firewalld, so blocking there does nothing.
#     The allowlist is enforced in Docker's own DOCKER-USER chain instead, for 443/tcp, 7881/tcp and
#     UDP 50000-50100. Port 80 stays open to everyone: Let's Encrypt must reach it to issue the
#     certificate, and it only redirects to HTTPS. A systemd unit re-applies the allowlist at boot.

TCP_PORTS="80 443 7881"
UDP_RANGE="50000:50100"
UNIT=/etc/systemd/system/warroom-now-firewall.service

SUDO=""
need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null || die "firewall changes need root; run as root or install sudo"
    SUDO="sudo"
  fi
}

host_firewall() {
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then echo ufw
  elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then echo firewalld
  else echo none; fi
}

open_host_firewall() {
  local fw; fw="$(host_firewall)"
  case "$fw" in
    ufw)
      for p in $TCP_PORTS; do $SUDO ufw allow "$p/tcp" comment warroom-now >/dev/null; done
      $SUDO ufw allow "$UDP_RANGE/udp" comment warroom-now >/dev/null
      echo "Opened TCP $TCP_PORTS and UDP ${UDP_RANGE/:/-} in ufw." ;;
    firewalld)
      for p in $TCP_PORTS; do $SUDO firewall-cmd -q --permanent --add-port="$p/tcp"; done
      $SUDO firewall-cmd -q --permanent --add-port="${UDP_RANGE/:/-}/udp"
      $SUDO firewall-cmd -q --reload
      echo "Opened TCP $TCP_PORTS and UDP ${UDP_RANGE/:/-} in firewalld." ;;
    *) echo "No active ufw or firewalld found on this server; nothing to open here." ;;
  esac
}

close_host_firewall() {
  case "$(host_firewall)" in
    ufw)
      for p in $TCP_PORTS; do $SUDO ufw delete allow "$p/tcp" >/dev/null 2>&1 || true; done
      $SUDO ufw delete allow "$UDP_RANGE/udp" >/dev/null 2>&1 || true ;;
    firewalld)
      for p in $TCP_PORTS; do $SUDO firewall-cmd -q --permanent --remove-port="$p/tcp" 2>/dev/null || true; done
      $SUDO firewall-cmd -q --permanent --remove-port="${UDP_RANGE/:/-}/udp" 2>/dev/null || true
      $SUDO firewall-cmd -q --reload ;;
  esac
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

# Remove our rules from DOCKER-USER (and the chain), for one of iptables / ip6tables.
fw_clear_one() {
  local ipt="$1" rule
  command -v "$ipt" >/dev/null 2>&1 || return 0
  $SUDO "$ipt" -S DOCKER-USER 2>/dev/null | grep -- '--comment warroom-now' | sed 's/^-A /-D /' | while read -r rule; do
    eval "$SUDO $ipt $rule" || true
  done
  $SUDO "$ipt" -F WARROOM-NOW 2>/dev/null || true
  $SUDO "$ipt" -X WARROOM-NOW 2>/dev/null || true
}

fw_apply_one() {
  local ipt="$1" list="$2" ext="$3" e family
  command -v "$ipt" >/dev/null 2>&1 || return 0
  if ! $SUDO "$ipt" -n -L DOCKER-USER >/dev/null 2>&1; then
    warn "$ipt: Docker's DOCKER-USER chain isn't there (is Docker running with its iptables firewall?); allowlist not applied for ${ipt}."
    return 1
  fi
  fw_clear_one "$ipt"
  [ -n "$list" ] || return 0
  [ "$ipt" = ip6tables ] && family=6 || family=4
  $SUDO "$ipt" -N WARROOM-NOW
  for e in $list; do
    if [ "$family" = 4 ] && [[ "$e" != *:* ]]; then $SUDO "$ipt" -A WARROOM-NOW -s "$e" -j RETURN; fi
    if [ "$family" = 6 ] && [[ "$e" == *:* ]]; then $SUDO "$ipt" -A WARROOM-NOW -s "$e" -j RETURN; fi
  done
  $SUDO "$ipt" -A WARROOM-NOW -j DROP
  # Only new connections arriving from outside, to War Room's ports (80 stays open for certificates).
  $SUDO "$ipt" -I DOCKER-USER -i "$ext" -p tcp -m multiport --dports 443,7881 -m conntrack --ctstate NEW -m comment --comment warroom-now -j WARROOM-NOW
  $SUDO "$ipt" -I DOCKER-USER -i "$ext" -p udp --dport "$UDP_RANGE" -m conntrack --ctstate NEW -m comment --comment warroom-now -j WARROOM-NOW
}

# Apply ALLOW_IPS from the state file (no prompts; also what the boot-time unit runs).
fw_apply() {
  local list="${ALLOW_IPS:-}" ext
  ext="$(ip -o route show default 2>/dev/null | awk '{print $5; exit}')"
  [ -n "$ext" ] || ext="$(ip -o -6 route show default 2>/dev/null | awk '{print $5; exit}')"
  if [ -n "$list" ] && [ -z "$ext" ]; then warn "Couldn't find this server's internet-facing network interface; allowlist not applied."; return 1; fi
  command -v iptables >/dev/null 2>&1 || { [ -z "$list" ] || warn "iptables isn't installed; the IP allowlist can't be applied."; return 0; }
  fw_apply_one iptables "$list" "$ext" || true
  fw_apply_one ip6tables "$list" "$ext" || true
  if [ -n "$list" ]; then
    install_unit
    echo "Only these addresses can reach War Room (HTTPS and voice): $list"
  else
    remove_unit
  fi
}

install_unit() {
  command -v systemctl >/dev/null 2>&1 || { warn "No systemd: after a reboot, run ./warroom-now.sh up again to restore the IP allowlist."; return 0; }
  local here; here="$(pwd)"
  $SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=War Room NOW IP allowlist (re-applied after Docker starts)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/env bash $here/warroom-now.sh firewall-apply

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable -q warroom-now-firewall.service
}

remove_unit() {
  [ -f "$UNIT" ] || return 0
  $SUDO systemctl disable -q warroom-now-firewall.service 2>/dev/null || true
  $SUDO rm -f "$UNIT"
  $SUDO systemctl daemon-reload 2>/dev/null || true
}

save_state_var() { # save_state_var NAME VALUE
  local tmp; tmp="$(mktemp)"
  grep -v "^$1=" "$STATE" > "$tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$STATE"; rm -f "$tmp"
}

# Interactive: open the host firewall, ask for allowed IPs, save and apply.
ask_firewall() {
  need_root
  echo
  bold "Firewall"
  local fw a raw me=""
  fw="$(host_firewall)"
  if [ "$fw" != none ]; then
    ask a "$fw is active. Open War Room's ports in it (TCP 80, 443, 7881 and UDP 50000-50100)? (Y/n)" "Y"
    case "$a" in [nN]*) warn "Leaving $fw as it is; people may not be able to connect." ;; *) open_host_firewall ;; esac
  else
    echo "No active ufw or firewalld on this server."
  fi
  echo
  echo "Restrict who can connect? Enter IP addresses or CIDR ranges separated by commas,"
  echo "for example 203.0.113.7, 198.51.100.0/24. Leave blank to allow everyone."
  echo "Everyone who joins (including guests) needs to come from one of these addresses."
  [ -n "${SSH_CLIENT:-}" ] && me="${SSH_CLIENT%% *}" && echo "You're connected from $me; include it if you'll use War Room from here."
  [ -n "${ALLOW_IPS:-}" ] && echo "Press Enter to keep the current list, or type all to allow everyone again."
  ask raw "Allowed addresses" "${ALLOW_IPS:-}"
  case "$(echo "$raw" | tr '[:upper:]' '[:lower:]' | tr -d ' ')" in all | any | everyone | '*') raw="" ;; esac
  ALLOW_IPS="$(parse_allowlist "$raw")"
  save_state_var ALLOW_IPS "$ALLOW_IPS"
  fw_apply
  [ -n "$ALLOW_IPS" ] || echo "Anyone on the internet can reach War Room (they still need an invite and a code to get in)."
  warn "Also open the same ports in your cloud provider's firewall / security group; this script can't change that."
}

cmd_firewall() {
  need_docker; load_state
  ask_firewall
}

# Used by the boot-time unit: re-apply the saved allowlist without asking anything.
cmd_firewall_apply() {
  load_state
  fw_apply
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
    # Re-apply a saved IP allowlist (it's lost on reboot if systemd isn't there to do it).
    [ -z "${ALLOW_IPS:-}" ] || { need_root; fw_apply; }
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
  if [ -n "${ALLOW_IPS:-}" ]; then echo "Allowed addresses: $ALLOW_IPS  (change with ./warroom-now.sh firewall)"; fi
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
  need_root
  fw_clear_one iptables; fw_clear_one ip6tables; remove_unit
  if [ "$(host_firewall)" != none ]; then
    ask a "Close War Room's ports in $(host_firewall) again? (Y/n)" "Y"
    case "$a" in [nN]*) ;; *) close_host_firewall ;; esac
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
  firewall-apply) cmd_firewall_apply ;;
  *) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
