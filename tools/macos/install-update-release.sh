#!/bin/sh
set -eu

VERSION="${QBANK_RELEASE_VERSION:?missing release version}"
case "$VERSION" in
  *[!0-9.]*|.*|*..*|*.) echo "invalid release version" >&2; exit 1 ;;
esac
case "$VERSION" in
  *.*.*) ;;
  *) echo "invalid release version" >&2; exit 1 ;;
esac
if [ "$(id -u)" -ne 0 ]; then echo 'release deployment requires root SSH access' >&2; exit 1; fi

ROOT=/var/lib/qbank-desktop-updates
RELEASES="$ROOT/releases"
RELEASE="$RELEASES/$VERSION"
ARCHIVE="qbank-macos-arm64-$VERSION.app.tar.gz"
INCOMING="/tmp/$ARCHIVE"
INCOMING_SIG="$INCOMING.sig"
INCOMING_MANIFEST=/tmp/latest.json
INCOMING_CADDY=/tmp/qbank-domain.caddy
DOMAIN_CONFIG=/etc/caddy/qbank-domain.caddy
EXPECTED_BASELINE_SHA=82056eb456b171adb652edc2625b148c5db4fb224d651a6239b806d2abe32438
EXPECTED_PREVIOUS_UPDATE_SHA=81267eab882d5cb3af10e772e883ac3bf205487f76843db355ecf65ef67a4d8d

for file in "$INCOMING" "$INCOMING_SIG" "$INCOMING_MANIFEST" "$INCOMING_CADDY"; do
  [ -s "$file" ] || { echo "missing staged release file: $file" >&2; exit 1; }
done
node - "$INCOMING_MANIFEST" "$VERSION" "$ARCHIVE" "$INCOMING_SIG" <<'NODE'
const fs = require('node:fs');
const [manifestPath, version, archive, sigPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const platform = manifest.platforms?.['darwin-aarch64'];
if (manifest.version !== version || !platform || !platform.signature || !platform.url.endsWith(`/releases/${archive}`)) {
  throw new Error('release manifest does not match staged package');
}
if (platform.signature !== fs.readFileSync(sigPath, 'utf8').trim()) throw new Error('manifest signature differs from .sig file');
NODE

mkdir -p "$RELEASES" /var/backups/qbank-auth
chown root:caddy "$ROOT" "$RELEASES" 2>/dev/null || true
chmod 0750 "$ROOT" "$RELEASES"
mkdir -p "$RELEASE"
chown root:caddy "$RELEASE"
chmod 0750 "$RELEASE"
if [ -e "$RELEASE/$ARCHIVE" ]; then
  cmp -s "$INCOMING" "$RELEASE/$ARCHIVE" || { echo "immutable release archive already exists with different bytes" >&2; exit 1; }
else
  install -o root -g caddy -m 0640 "$INCOMING" "$RELEASE/$ARCHIVE"
fi
if [ -e "$RELEASE/$ARCHIVE.sig" ]; then
  cmp -s "$INCOMING_SIG" "$RELEASE/$ARCHIVE.sig" || { echo "immutable release signature already differs" >&2; exit 1; }
else
  install -o root -g caddy -m 0640 "$INCOMING_SIG" "$RELEASE/$ARCHIVE.sig"
fi
sha256sum "$RELEASE/$ARCHIVE" "$RELEASE/$ARCHIVE.sig" > "$RELEASE/SHA256SUMS"
chown root:caddy "$RELEASE/SHA256SUMS"
chmod 0640 "$RELEASE/SHA256SUMS"
if [ -e "$RELEASES/$ARCHIVE" ]; then
  cmp -s "$INCOMING" "$RELEASES/$ARCHIVE" || { echo "flat release archive already exists with different bytes" >&2; exit 1; }
else
  ln "$RELEASE/$ARCHIVE" "$RELEASES/$ARCHIVE"
fi
if [ -e "$RELEASES/$ARCHIVE.sig" ]; then
  cmp -s "$INCOMING_SIG" "$RELEASES/$ARCHIVE.sig" || { echo "flat release signature already differs" >&2; exit 1; }
else
  ln "$RELEASE/$ARCHIVE.sig" "$RELEASES/$ARCHIVE.sig"
fi

changed=0
if ! cmp -s "$INCOMING_CADDY" "$DOMAIN_CONFIG"; then
  current_sha=$(sha256sum "$DOMAIN_CONFIG" | awk '{print $1}')
  if [ "$current_sha" != "$EXPECTED_BASELINE_SHA" ] && [ "$current_sha" != "$EXPECTED_PREVIOUS_UPDATE_SHA" ]; then
    echo "Caddy domain config changed since release setup; saved files are untouched, inspect $DOMAIN_CONFIG before deploying." >&2
    exit 1
  fi
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="/var/backups/qbank-auth/${stamp}-qbank-domain.caddy"
  cp -p "$DOMAIN_CONFIG" "$backup"
  install -o root -g root -m 0644 "$INCOMING_CADDY" "$DOMAIN_CONFIG.next"
  mv "$DOMAIN_CONFIG.next" "$DOMAIN_CONFIG"
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cp -p "$backup" "$DOMAIN_CONFIG"
    echo "Caddy validation failed; restored the previous domain config." >&2
    exit 1
  fi
  if ! caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cp -p "$backup" "$DOMAIN_CONFIG"
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
    echo "Caddy reload failed; restored the previous domain config." >&2
    exit 1
  fi
  changed=1
fi

if [ -e "$ROOT/latest.json" ]; then
  cp -p "$ROOT/latest.json" "/var/backups/qbank-auth/$(date -u +%Y%m%dT%H%M%SZ)-desktop-latest.json"
fi
install -o root -g caddy -m 0640 "$INCOMING_MANIFEST" "$ROOT/.latest-$VERSION.json"
mv -f "$ROOT/.latest-$VERSION.json" "$ROOT/latest.json"

if command -v curl >/dev/null 2>&1; then
  verified=0
  attempt=0
  while [ "$attempt" -lt 6 ]; do
    attempt=$((attempt + 1))
    if curl --fail --silent --show-error --resolve qbank.creart.top:8443:127.0.0.1 \
      https://qbank.creart.top:8443/v1/desktop/latest.json -o /tmp/qbank-desktop-update-check.json \
      && curl --fail --silent --show-error --head --resolve qbank.creart.top:8443:127.0.0.1 \
        "https://qbank.creart.top:8443/v1/desktop/releases/$ARCHIVE" >/dev/null; then
      verified=1
      break
    fi
    sleep 1
  done
  [ "$verified" -eq 1 ] || { echo 'updated Caddy route did not serve the feed and archive over HTTPS.' >&2; exit 1; }
  node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(m.version!==process.argv[2])process.exit(1)' \
    /tmp/qbank-desktop-update-check.json "$VERSION"
else
  echo 'curl unavailable; host-side HTTPS fetch was skipped.'
fi

echo "macOS update $VERSION published at $RELEASE"
echo "latest manifest: $ROOT/latest.json"
echo "Caddy route: $([ "$changed" -eq 1 ] && echo installed || echo already active)"
