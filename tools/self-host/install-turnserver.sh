#!/bin/sh
set -eu

PUBLIC_HOST="${QBANK_TURN_HOST:-qbank.acharrystar.top}"
PUBLIC_IP="${QBANK_TURN_PUBLIC_IP:-}"
REALM="${QBANK_TURN_REALM:-$PUBLIC_HOST}"
LISTEN_PORT="${QBANK_TURN_PORT:-8004}"
MIN_PORT="${QBANK_TURN_MIN_PORT:-8005}"
MAX_PORT="${QBANK_TURN_MAX_PORT:-8011}"
SECRET_FILE=/etc/turnserver-auth.secret
CONFIG=/etc/turnserver.conf
ENABLE_FILE=/etc/default/coturn

[ "$(id -u)" -eq 0 ] || { echo 'TURN deployment requires root SSH access' >&2; exit 1; }
command -v turnserver >/dev/null 2>&1 || { echo 'coturn is not installed' >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo 'openssl is required' >&2; exit 1; }
printf '%s' "$PUBLIC_HOST" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo 'invalid TURN host' >&2; exit 1; }
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(getent ahostsv4 "$PUBLIC_HOST" | awk 'NR == 1 { print $1 }')
fi
printf '%s' "$PUBLIC_IP" | grep -Eq '^[0-9]{1,3}([.][0-9]{1,3}){3}$' || { echo 'invalid TURN public IP' >&2; exit 1; }
[ "$LISTEN_PORT" -ge 1024 ] 2>/dev/null && [ "$LISTEN_PORT" -le 65535 ] 2>/dev/null \
  || { echo 'invalid TURN listening port' >&2; exit 1; }
[ "$MIN_PORT" -ge 1024 ] 2>/dev/null && [ "$MAX_PORT" -ge "$MIN_PORT" ] 2>/dev/null \
  || { echo 'invalid TURN relay port range' >&2; exit 1; }

if [ -n "${QBANK_TURN_SECRET:-}" ]; then
  secret="$QBANK_TURN_SECRET"
elif [ -s "$SECRET_FILE" ]; then
  secret=$(tr -d '\r\n' < "$SECRET_FILE")
else
  secret=$(openssl rand -hex 32)
fi
printf '%s' "$secret" | grep -Eq '^[A-Za-z0-9_-]{32,128}$' || { echo 'invalid TURN shared secret' >&2; exit 1; }

umask 077
config_temp=$(mktemp /tmp/qbank-turnserver-conf.XXXXXX)
secret_temp=$(mktemp /tmp/qbank-turnserver-secret.XXXXXX)
config_backup=/tmp/qbank-turnserver-conf.previous
restore_config() {
  if [ -s "$config_backup" ]; then
    install -o root -g turnserver -m 0640 "$config_backup" "$CONFIG"
    systemctl restart coturn >/dev/null 2>&1 || true
  fi
  rm -f "$config_temp" "$secret_temp"
}
trap restore_config EXIT HUP INT TERM

cat > "$config_temp" <<EOF
listening-port=$LISTEN_PORT
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=$secret
realm=$REALM
server-name=$PUBLIC_HOST
external-ip=$PUBLIC_IP
min-port=$MIN_PORT
max-port=$MAX_PORT
stale-nonce=600
total-quota=32
user-quota=4
no-cli
no-loopback-peers
no-multicast-peers
EOF
printf '%s\n' "$secret" > "$secret_temp"

if [ -s "$CONFIG" ]; then cp -p "$CONFIG" "$config_backup"; else : > "$config_backup"; fi
install -o root -g turnserver -m 0640 "$config_temp" "$CONFIG"
install -o root -g turnserver -m 0640 "$secret_temp" "$SECRET_FILE"
if grep -q '^#*TURNSERVER_ENABLED=' "$ENABLE_FILE"; then
  sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "$ENABLE_FILE"
else
  printf '\nTURNSERVER_ENABLED=1\n' >> "$ENABLE_FILE"
fi

systemctl daemon-reload
systemctl enable coturn >/dev/null
if ! systemctl restart coturn; then
  restore_config
  echo 'coturn failed to start; restored its previous configuration.' >&2
  exit 1
fi
systemctl is-active --quiet coturn || {
  restore_config
  echo 'coturn is not active; restored its previous configuration.' >&2
  exit 1
}
ss -lntu | grep -Eq ":($LISTEN_PORT)[[:space:]]" || {
  restore_config
  echo 'coturn did not open the expected listener; restored its previous configuration.' >&2
  exit 1
}

trap - EXIT HUP INT TERM
rm -f "$config_temp" "$secret_temp"
echo "TURN listener installed at $PUBLIC_HOST:$LISTEN_PORT with relay ports $MIN_PORT-$MAX_PORT"
