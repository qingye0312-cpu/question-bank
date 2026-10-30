#!/bin/sh
set -eu
umask 077

DOMAIN="${QBANK_DOMAIN:-qbank.acharrystar.top}"
ACME_HOME="${QBANK_ACME_HOME:-/root/.acme.sh}"
ACME_BIN="${QBANK_ACME_BIN:-/usr/bin/acme.sh}"
CREDENTIALS="${QBANK_ACME_CREDENTIALS:-/etc/qbank-cert/acme.env}"
INSTALLER=/usr/local/sbin/qbank-install-domain-certificate
DAILY=/etc/periodic/daily/qbank-certificate-renew
ISSUE_ONLY=0

[ "${1:-}" = "--issue-only" ] && ISSUE_ONLY=1

[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$' \
  || { echo 'Invalid domain.' >&2; exit 1; }
[ -x "$ACME_BIN" ] || { echo "Missing acme.sh: $ACME_BIN" >&2; exit 1; }
[ -x "$INSTALLER" ] || { echo "Install $INSTALLER before enabling renewal." >&2; exit 1; }

if [ ! -f "$CREDENTIALS" ]; then
  access_key="${QBANK_ALIYUN_ACCESS_KEY_ID:-}"
  access_secret="${QBANK_ALIYUN_ACCESS_KEY_SECRET:-}"
  [ -n "$access_key" ] && [ -n "$access_secret" ] || {
    echo "Missing Aliyun DNS credentials. Set QBANK_ALIYUN_ACCESS_KEY_ID and QBANK_ALIYUN_ACCESS_KEY_SECRET once." >&2
    exit 1
  }
  printf '%s%s' "$access_key" "$access_secret" | grep -Eq '^[A-Za-z0-9._~+/=-]+$' \
    || { echo 'Aliyun DNS credentials contain unsupported characters.' >&2; exit 1; }
  install -d -m 0700 -o root -g root "$(dirname "$CREDENTIALS")"
  temporary="$CREDENTIALS.$$"
  printf 'Ali_Key="%s"\nAli_Secret="%s"\n' "$access_key" "$access_secret" >"$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$CREDENTIALS"
fi

. "$CREDENTIALS"
: "${Ali_Key:?Ali_Key is missing from the credentials file}"
: "${Ali_Secret:?Ali_Secret is missing from the credentials file}"
export Ali_Key Ali_Secret

mkdir -p "$ACME_HOME"
"$ACME_BIN" --home "$ACME_HOME" --set-default-ca --server letsencrypt >/dev/null
"$ACME_BIN" --home "$ACME_HOME" --issue \
  --dns dns_ali \
  --domain "$DOMAIN" \
  --server letsencrypt \
  --keylength 2048 \
  --reloadcmd "$INSTALLER $ACME_HOME/$DOMAIN/fullchain.pem $ACME_HOME/$DOMAIN/$DOMAIN.key"

certificate="$ACME_HOME/$DOMAIN/fullchain.pem"
private_key="$ACME_HOME/$DOMAIN/$DOMAIN.key"
[ -s "$certificate" ] && [ -s "$private_key" ] \
  || { echo 'acme.sh did not produce the expected certificate files.' >&2; exit 1; }
if [ "$ISSUE_ONLY" -eq 1 ]; then
  echo "Certificate issued for $DOMAIN."
  exit 0
fi

"$INSTALLER" "$certificate" "$private_key"

install -d -m 0755 /etc/periodic/daily
cat >"$DAILY" <<EOF
#!/bin/sh
set -eu
exec "$ACME_BIN" --home "$ACME_HOME" --cron --server letsencrypt
EOF
chmod 0755 "$DAILY"

rc-update add crond default >/dev/null 2>&1 || true
rc-service crond start >/dev/null 2>&1 || true

echo "Automatic renewal enabled for $DOMAIN."
"$ACME_BIN" --home "$ACME_HOME" --list
