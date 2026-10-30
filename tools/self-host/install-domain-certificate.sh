#!/bin/sh
# Alpine: install a trusted certificate pair, then validate and hot-reload Caddy.
set -eu
set -o pipefail
umask 077

[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
[ "$#" -eq 2 ] || { echo 'Usage: install-domain-certificate.sh fullchain.pem privkey.pem' >&2; exit 1; }
domain="${QBANK_DOMAIN:-qbank.acharrystar.top}"
cert_root=/etc/caddy/certs/$domain
chain=$1
key=$2

printf '%s' "$domain" | grep -Eq '^[A-Za-z0-9.-]+$' \
  || { echo 'Invalid domain.' >&2; exit 1; }
exec 9>/run/qbank-certificate-install.lock
flock -n 9 || { echo 'Another certificate installation is running.' >&2; exit 1; }
openssl x509 -in "$chain" -noout -checkend 86400 >/dev/null
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt -purpose sslserver \
  -verify_hostname "$domain" -untrusted "$chain" "$chain" >/dev/null
cert_public=$(openssl x509 -in "$chain" -noout -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256)
key_public=$(openssl pkey -in "$key" -pubout -outform DER | openssl dgst -sha256)
[ "$cert_public" = "$key_public" ] || { echo 'Certificate and private key do not match.' >&2; exit 1; }

install -d -m 0750 -o root -g caddy /etc/caddy/certs "$cert_root" "$cert_root/versions"
previous=$(readlink "$cert_root/current" || true)
candidate=$(mktemp -d "$cert_root/versions/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
changed=0
committed=0
cleanup() {
  result=$?
  trap - EXIT
  if [ "$changed" -eq 1 ] && [ "$committed" -eq 0 ]; then
    if [ -n "$previous" ]; then
      ln -s "$previous" "$cert_root/.rollback-$$"
      mv -Tf "$cert_root/.rollback-$$" "$cert_root/current"
      rc-service caddy reload >/dev/null 2>&1 || true
    else
      rm -f "$cert_root/current"
    fi
  fi
  rm -f "$cert_root/.current-$$" "$candidate/health.json"
  if [ "$committed" -eq 0 ]; then rm -rf "$candidate"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -m 0640 -o root -g caddy "$chain" "$candidate/fullchain.pem"
install -m 0640 -o root -g caddy "$key" "$candidate/key.pem"
chown root:caddy "$candidate"
chmod 0750 "$candidate"
ln -s "versions/$(basename "$candidate")" "$cert_root/.current-$$"
mv -Tf "$cert_root/.current-$$" "$cert_root/current"
changed=1
rc-service caddy checkconfig
rc-service caddy reload
curl --noproxy '*' --fail --silent --show-error --max-time 15 \
  --resolve "$domain:8443:127.0.0.1" "https://$domain:8443/health" >"$candidate/health.json"
grep -q '"service":"qbank-auth"' "$candidate/health.json"
committed=1
echo 'Domain certificate installed; Caddy configuration and HTTPS health check passed.'
openssl x509 -in "$candidate/fullchain.pem" -noout -subject -issuer -dates
