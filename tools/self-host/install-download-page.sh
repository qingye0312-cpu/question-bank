#!/bin/sh
set -eu

SOURCE="${1:-/tmp/qbank-download-page/index.html}"
ROOT=/var/lib/qbank-desktop-updates
SITE="$ROOT/site"
DOMAIN_CONFIG=/etc/caddy/qbank-domain.caddy
MAIN_CONFIG=/etc/caddy/Caddyfile

[ "$(id -u)" -eq 0 ] || { echo 'download page deployment requires root SSH access' >&2; exit 1; }
[ -s "$SOURCE" ] || { echo "missing download page: $SOURCE" >&2; exit 1; }
[ -f "$DOMAIN_CONFIG" ] || { echo "missing Caddy domain config: $DOMAIN_CONFIG" >&2; exit 1; }
[ -f "$MAIN_CONFIG" ] || { echo "missing Caddy main config: $MAIN_CONFIG" >&2; exit 1; }

install -d -o root -g caddy -m 0750 "$SITE"
install -o root -g caddy -m 0640 "$SOURCE" "$SITE/index.html"

BACKUP="/tmp/qbank-domain.caddy.$$.bak"
TEMP="/tmp/qbank-domain.caddy.$$.tmp"
cp -p "$DOMAIN_CONFIG" "$BACKUP"
cleanup() { rm -f "$BACKUP" "$TEMP" /tmp/qbank-download-page-check.html; }
trap cleanup EXIT HUP INT TERM

if ! grep -q 'root \* /var/lib/qbank-desktop-updates/site' "$DOMAIN_CONFIG"; then
  awk '
    /^[[:space:]]*handle_path \/v1\/desktop\/releases\/\* \{/ && !inserted {
      print "\thandle /download* {"
      print "\t\troot * /var/lib/qbank-desktop-updates/site"
      print "\t\trewrite * /index.html"
      print "\t\theader Cache-Control \"no-cache\""
      print "\t\tfile_server"
      print "\t}"
      inserted = 1
    }
    { print }
    END { if (!inserted) exit 1 }
  ' "$DOMAIN_CONFIG" > "$TEMP" || { echo 'could not insert the download route into Caddy config' >&2; exit 1; }
  cat "$TEMP" > "$DOMAIN_CONFIG"
fi

if ! caddy validate --config "$MAIN_CONFIG" --adapter caddyfile; then
  cp -p "$BACKUP" "$DOMAIN_CONFIG"
  exit 1
fi
if ! caddy reload --config "$MAIN_CONFIG" --adapter caddyfile; then
  cp -p "$BACKUP" "$DOMAIN_CONFIG"
  caddy reload --config "$MAIN_CONFIG" --adapter caddyfile >/dev/null 2>&1 || true
  exit 1
fi

if ! curl --fail --silent --show-error --resolve qbank.creart.top:8443:127.0.0.1 \
  https://qbank.creart.top:8443/download -o /tmp/qbank-download-page-check.html \
  || ! grep -q '下载题库桌面版' /tmp/qbank-download-page-check.html; then
  cp -p "$BACKUP" "$DOMAIN_CONFIG"
  caddy reload --config "$MAIN_CONFIG" --adapter caddyfile >/dev/null 2>&1 || true
  echo 'the download page did not pass the local HTTPS check; Caddy config was restored' >&2
  exit 1
fi

echo "Download page deployed at https://qbank.creart.top:8013/download"
