#!/bin/sh
set -eu

HOST="${QBANK_SSH_HOST:-qbank-pve}"
DOMAIN="${QBANK_DOMAIN:-qbank.acharrystar.top}"
REMOTE_DIR=/tmp/qbank-domain-tls.$$

cleanup() {
  ssh "$HOST" "rm -rf '$REMOTE_DIR'" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

ssh "$HOST" "install -d -m 0700 '$REMOTE_DIR'"
scp tools/self-host/Caddyfile tools/self-host/Caddyfile.domain \
  tools/self-host/install-domain-certificate.sh \
  tools/self-host/install-domain-certificate-renewal.sh \
  tools/self-host/check-public-tls.mjs \
  "$HOST:$REMOTE_DIR/"

ssh "$HOST" "
  set -eu
  install -o root -g root -m 0755 '$REMOTE_DIR/install-domain-certificate.sh' /usr/local/sbin/qbank-install-domain-certificate
  install -o root -g root -m 0755 '$REMOTE_DIR/install-domain-certificate-renewal.sh' /usr/local/sbin/qbank-install-domain-certificate-renewal
  install -o root -g root -m 0755 '$REMOTE_DIR/check-public-tls.mjs' /usr/local/sbin/qbank-check-public-tls.mjs
  backup_dir=\$(mktemp -d /tmp/qbank-domain-config.XXXXXX)
  cp -p /etc/caddy/Caddyfile \"\$backup_dir/Caddyfile\"
  cp -p /etc/caddy/qbank-domain.caddy \"\$backup_dir/qbank-domain.caddy\"
  restore=1
  cleanup() {
    if [ \"\$restore\" -eq 1 ]; then
      cp -p \"\$backup_dir/Caddyfile\" /etc/caddy/Caddyfile
      cp -p \"\$backup_dir/qbank-domain.caddy\" /etc/caddy/qbank-domain.caddy
      rc-service caddy reload >/dev/null 2>&1 || true
    fi
    rm -rf \"\$backup_dir\"
  }
  trap cleanup EXIT HUP INT TERM
  QBANK_DOMAIN='$DOMAIN' sh /usr/local/sbin/qbank-install-domain-certificate-renewal --issue-only
  install -o root -g root -m 0644 '$REMOTE_DIR/Caddyfile' /etc/caddy/Caddyfile
  install -o root -g root -m 0644 '$REMOTE_DIR/Caddyfile.domain' /etc/caddy/qbank-domain.caddy
  rc-service caddy checkconfig
  QBANK_DOMAIN='$DOMAIN' sh /usr/local/sbin/qbank-install-domain-certificate-renewal
  node /usr/local/sbin/qbank-check-public-tls.mjs 'https://$DOMAIN:8013'
  restore=0
"
