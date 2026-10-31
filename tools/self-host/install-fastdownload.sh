#!/bin/sh
set -eu

ARCHIVE="${QBANK_FASTDOWNLOAD_ARCHIVE:-/tmp/qbank-fastdownload-0.1.0.tar.gz}"
CADDY_HOST="${QBANK_FASTDOWNLOAD_HOSTNAME:-qbank.acharrystar.top}"
PUBLIC_ORIGIN="${QBANK_FASTDOWNLOAD_PUBLIC_ORIGIN:-https://qbank.acharrystar.top:8013}"
STUN_URLS="${QBANK_FASTDOWNLOAD_STUN_URLS:-stun:stun.cloudflare.com:3478}"
REQUESTED_TURN_URLS="${QBANK_FASTDOWNLOAD_TURN_URLS:-}"
REQUESTED_TURN_SECRET="${QBANK_FASTDOWNLOAD_TURN_SECRET:-}"
REQUESTED_TURN_TTL="${QBANK_FASTDOWNLOAD_TURN_TTL_SECONDS:-}"
REQUESTED_ICE_PORT_RANGE="${QBANK_FASTDOWNLOAD_ICE_PORT_RANGE:-}"
RELEASE_ROOT=/opt/qbank-fastdownload/releases
CURRENT=/opt/qbank-fastdownload/current
SITE_ROOT=/var/lib/qbank-fastdownload/site
DOMAIN_CONFIG=/etc/caddy/qbank-domain.caddy
MAIN_CONFIG=/etc/caddy/Caddyfile
SERVICE_INITD=/etc/init.d/qbank-fastdownload
SERVICE_CONF=/etc/conf.d/qbank-fastdownload

EXISTING_TURN_URLS=''
EXISTING_TURN_SECRET=''
EXISTING_TURN_TTL=''
EXISTING_ICE_PORT_RANGE=''
if [ -f "$SERVICE_CONF" ]; then
  . "$SERVICE_CONF"
  EXISTING_TURN_URLS="${QBANK_FASTDOWNLOAD_TURN_URLS:-}"
  EXISTING_TURN_SECRET="${QBANK_FASTDOWNLOAD_TURN_SECRET:-}"
  EXISTING_TURN_TTL="${QBANK_FASTDOWNLOAD_TURN_TTL_SECONDS:-}"
  EXISTING_ICE_PORT_RANGE="${QBANK_FASTDOWNLOAD_ICE_PORT_RANGE:-}"
fi
TURN_URLS="${REQUESTED_TURN_URLS:-$EXISTING_TURN_URLS}"
TURN_SECRET="${REQUESTED_TURN_SECRET:-$EXISTING_TURN_SECRET}"
TURN_TTL="${REQUESTED_TURN_TTL:-${EXISTING_TURN_TTL:-3600}}"
ICE_PORT_RANGE="${REQUESTED_ICE_PORT_RANGE:-$EXISTING_ICE_PORT_RANGE}"

[ "$(id -u)" -eq 0 ] || { echo 'fastdownload deployment requires root SSH access' >&2; exit 1; }
[ -s "$ARCHIVE" ] || { echo "missing fastdownload package: $ARCHIVE" >&2; exit 1; }
[ -f "$DOMAIN_CONFIG" ] || { echo "missing Caddy domain config: $DOMAIN_CONFIG" >&2; exit 1; }
[ -f "$MAIN_CONFIG" ] || { echo "missing Caddy main config: $MAIN_CONFIG" >&2; exit 1; }
id qbank >/dev/null 2>&1 || { echo 'qbank service account is missing' >&2; exit 1; }
id caddy >/dev/null 2>&1 || { echo 'Caddy service account is missing' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' \
  || { echo 'fastdownload requires Node.js 22 or newer' >&2; exit 1; }
printf '%s' "$CADDY_HOST" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo 'invalid Caddy host' >&2; exit 1; }
printf '%s' "$PUBLIC_ORIGIN" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' || { echo 'invalid public origin' >&2; exit 1; }
printf '%s' "$STUN_URLS" | grep -Eq '^[A-Za-z0-9:.,/_-]+$' || { echo 'invalid STUN URL list' >&2; exit 1; }
if [ -n "$TURN_URLS$TURN_SECRET" ] && { [ -z "$TURN_URLS" ] || [ -z "$TURN_SECRET" ]; }; then
  echo 'TURN URL and shared secret must be configured together' >&2
  exit 1
fi
if [ -n "$TURN_URLS" ]; then
  printf '%s' "$TURN_URLS" | grep -Eq '^[A-Za-z0-9:.,/_?=&-]+$' || { echo 'invalid TURN URL list' >&2; exit 1; }
  printf '%s' "$TURN_SECRET" | grep -Eq '^[A-Za-z0-9_-]{32,128}$' || { echo 'invalid TURN shared secret' >&2; exit 1; }
  case "$TURN_TTL" in ''|*[!0-9]*) echo 'invalid TURN credential lifetime' >&2; exit 1;; esac
  [ "$TURN_TTL" -ge 60 ] && [ "$TURN_TTL" -le 86400 ] \
    || { echo 'TURN credential lifetime must be 60 to 86400 seconds' >&2; exit 1; }
fi
if [ -n "$ICE_PORT_RANGE" ]; then
  printf '%s' "$ICE_PORT_RANGE" | grep -Eq '^[0-9]{4,5}-[0-9]{4,5}$' \
    || { echo 'invalid ICE port range' >&2; exit 1; }
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
release="$RELEASE_ROOT/$stamp"
mkdir -p "$release" "$SITE_ROOT/fastdownload" /var/log
tar -xzf "$ARCHIVE" -C "$release"
[ -s "$release/server/server.mjs" ] || { echo 'package is missing server/server.mjs' >&2; exit 1; }
[ -s "$release/server/node_modules/werift/package.json" ] || { echo 'package is missing the pinned werift runtime' >&2; exit 1; }
[ -s "$release/site/fastdownload/index.html" ] || { echo 'package is missing the separate fastdownload page' >&2; exit 1; }
[ -s "$release/site/fastdownload/sha256-worker.js" ] || { echo 'package is missing the SHA-256 worker' >&2; exit 1; }
chmod -R a+rX "$release"

install -o root -g caddy -m 0640 "$release/site/fastdownload/index.html" "$SITE_ROOT/fastdownload/index.html"
install -o root -g caddy -m 0640 "$release/site/fastdownload/sha256-worker.js" "$SITE_ROOT/fastdownload/sha256-worker.js"

OLD_TARGET=''
if [ -L "$CURRENT" ]; then OLD_TARGET=$(readlink "$CURRENT"); fi
BACKUP="/tmp/qbank-domain-fastdownload.$$.bak"
TEMP="/tmp/qbank-domain-fastdownload.$$.tmp"
INITD_BACKUP="/tmp/qbank-fastdownload-initd.$$.bak"
CONF_BACKUP="/tmp/qbank-fastdownload-conf.$$.bak"
OLD_INITD=no
OLD_CONF=no
if [ -f "$SERVICE_INITD" ]; then cp -p "$SERVICE_INITD" "$INITD_BACKUP"; OLD_INITD=yes; fi
if [ -f "$SERVICE_CONF" ]; then cp -p "$SERVICE_CONF" "$CONF_BACKUP"; OLD_CONF=yes; fi
cp -p "$DOMAIN_CONFIG" "$BACKUP"
cleanup() {
  rm -f "$BACKUP" "$TEMP" "$INITD_BACKUP" "$CONF_BACKUP" \
    /tmp/qbank-fastdownload-page-check.html /tmp/qbank-fastdownload-config-check.json
}
trap cleanup EXIT HUP INT TERM

rm -f "$CURRENT"
ln -s "$release" "$CURRENT"

rollback() {
  cp -p "$BACKUP" "$DOMAIN_CONFIG"
  caddy reload --config "$MAIN_CONFIG" --adapter caddyfile >/dev/null 2>&1 || true
  if [ -n "$OLD_TARGET" ]; then
    if [ "$OLD_INITD" = yes ]; then cp -p "$INITD_BACKUP" "$SERVICE_INITD"; else rm -f "$SERVICE_INITD"; fi
    if [ "$OLD_CONF" = yes ]; then cp -p "$CONF_BACKUP" "$SERVICE_CONF"; else rm -f "$SERVICE_CONF"; fi
    rm -f "$CURRENT"
    ln -s "$OLD_TARGET" "$CURRENT"
    rc-service qbank-fastdownload restart >/dev/null 2>&1 || true
  else
    rc-update del qbank-fastdownload default >/dev/null 2>&1 || true
    rc-service qbank-fastdownload stop >/dev/null 2>&1 || true
    rm -f "$CURRENT"
    rm -f "$SERVICE_INITD" "$SERVICE_CONF"
  fi
  rm -rf -- "$release"
}

if ! grep -q 'handle /fastdownload/api\*' "$DOMAIN_CONFIG"; then
  awk '
    /^[[:space:]]*handle_path \/v1\/desktop\/releases\/\*/ && !inserted {
      print "\thandle /fastdownload/api* {"
      print "\t\treverse_proxy 127.0.0.1:8090"
      print "\t}"
      print "\thandle /fastdownload* {"
      print "\t\troot * /var/lib/qbank-fastdownload/site"
      print "\t\t@fastdownloadIndex path /fastdownload /fastdownload/"
      print "\t\trewrite @fastdownloadIndex /fastdownload/index.html"
      print "\t\theader Cache-Control \"no-cache\""
      print "\t\tfile_server"
      print "\t}"
      inserted = 1
    }
    { print }
    END { if (!inserted) exit 1 }
  ' "$DOMAIN_CONFIG" > "$TEMP" || { echo 'could not add the isolated /fastdownload routes' >&2; exit 1; }
  cat "$TEMP" > "$DOMAIN_CONFIG"
fi

install -o root -g root -m 0755 "$release/service/qbank-fastdownload.initd" "$SERVICE_INITD"
mkdir -p /etc/conf.d
{
  printf 'export QBANK_FASTDOWNLOAD_BIND_HOST="%s"\n' "127.0.0.1"
  printf 'export QBANK_FASTDOWNLOAD_PORT="%s"\n' "8090"
  printf 'export QBANK_FASTDOWNLOAD_CADDY_HOST="%s"\n' "$CADDY_HOST"
  printf 'export QBANK_FASTDOWNLOAD_CADDY_PORT="%s"\n' "8443"
  printf 'export QBANK_FASTDOWNLOAD_ALLOWED_ORIGINS="%s"\n' "$PUBLIC_ORIGIN"
  printf 'export QBANK_FASTDOWNLOAD_STUN_URLS="%s"\n' "$STUN_URLS"
  if [ -n "$ICE_PORT_RANGE" ]; then
    printf 'export QBANK_FASTDOWNLOAD_ICE_PORT_RANGE="%s"\n' "$ICE_PORT_RANGE"
  fi
  if [ -n "$TURN_URLS" ]; then
    printf 'export QBANK_FASTDOWNLOAD_TURN_URLS="%s"\n' "$TURN_URLS"
    printf 'export QBANK_FASTDOWNLOAD_TURN_SECRET="%s"\n' "$TURN_SECRET"
    printf 'export QBANK_FASTDOWNLOAD_TURN_TTL_SECONDS="%s"\n' "$TURN_TTL"
  fi
} > "$SERVICE_CONF"
chown root:qbank "$SERVICE_CONF"
chmod 0640 "$SERVICE_CONF"
rc-update add qbank-fastdownload default
touch /var/log/qbank-fastdownload.log /var/log/qbank-fastdownload.err
chown qbank:qbank /var/log/qbank-fastdownload.log /var/log/qbank-fastdownload.err
chmod 0640 /var/log/qbank-fastdownload.log /var/log/qbank-fastdownload.err

if ! caddy validate --config "$MAIN_CONFIG" --adapter caddyfile; then
  rollback
  echo 'Caddy rejected the fastdownload routes; restored its prior configuration.' >&2
  exit 1
fi
if ! rc-service qbank-fastdownload restart; then
  rc-service qbank-fastdownload start || { rollback; echo 'fastdownload service did not start.' >&2; exit 1; }
fi
rc-service qbank-fastdownload status || true
if ! caddy reload --config "$MAIN_CONFIG" --adapter caddyfile; then
  rollback
  echo 'Caddy reload failed; restored its prior configuration.' >&2
  exit 1
fi

verified=no
attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl --noproxy '*' --fail --silent --resolve "$CADDY_HOST:8443:127.0.0.1" \
    "https://$CADDY_HOST:8443/fastdownload" -o /tmp/qbank-fastdownload-page-check.html \
    && grep -q '快速下载实验' /tmp/qbank-fastdownload-page-check.html \
    && curl --fail --silent http://127.0.0.1:8090/fastdownload/api/config \
      -H "Origin: $PUBLIC_ORIGIN" -o /tmp/qbank-fastdownload-config-check.json \
    && grep -q 'iceServers' /tmp/qbank-fastdownload-config-check.json; then
    verified=yes
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$verified" != yes ]; then
  page_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --resolve "$CADDY_HOST:8443:127.0.0.1" "https://$CADDY_HOST:8443/fastdownload" 2>&1 || true)
  api_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:8090/fastdownload/api/config \
    -H "Origin: $PUBLIC_ORIGIN" 2>&1 || true)
  echo "fastdownload diagnostics: page=$page_status api=$api_status"
  rc-service qbank-fastdownload status || true
  tail -n 20 /var/log/qbank-fastdownload.err /var/log/qbank-fastdownload.log || true
  rollback
  echo 'local page or signaling health check failed; restored Caddy and service state.' >&2
  exit 1
fi

for old_release in "$RELEASE_ROOT"/*; do
  [ -d "$old_release" ] || continue
  [ "$old_release" = "$release" ] && continue
  [ -n "$OLD_TARGET" ] && [ "$old_release" = "$OLD_TARGET" ] && continue
  rm -rf -- "$old_release"
done

echo "Experimental direct-download page installed at https://$CADDY_HOST:8013/fastdownload"
echo 'The existing /download page and its deployment script were not changed by this installer.'
