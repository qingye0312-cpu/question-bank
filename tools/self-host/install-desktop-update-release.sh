#!/bin/sh
set -eu

VERSION="${QBANK_RELEASE_VERSION:?missing release version}"
printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
  || { echo 'invalid release version' >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo 'release deployment requires root SSH access' >&2; exit 1; }

ROOT=/var/lib/qbank-desktop-updates
RELEASES="$ROOT/releases"
RELEASE="$RELEASES/$VERSION"
MACOS_RELEASE="$RELEASES/macos/$VERSION"
WINDOWS_RELEASE="$RELEASES/windows/$VERSION"
MAC_NAME="qbank-macos-arm64-$VERSION.app.tar.gz"
MAC_DMG_NAME="题库_${VERSION}_macOS_arm64.dmg"
WINDOWS_NAME="qbank-windows-x64-$VERSION.nsis.zip"
PORTABLE_NAME='题库_windows_x64_portable.exe'
SETUP_NAME='题库_windows_x64_setup.exe'
MAC_IN="/tmp/$MAC_NAME"
MAC_DMG_IN="/tmp/$MAC_DMG_NAME"
WINDOWS_IN="/tmp/$WINDOWS_NAME"
MANIFEST_IN=/tmp/latest.json
BACKUPS=/var/backups/qbank-desktop-updates
DOMAIN_CONFIG=/etc/caddy/qbank-domain.caddy

for file in "$MAC_IN" "$MAC_IN.sig" "$MAC_DMG_IN" "$WINDOWS_IN" "$WINDOWS_IN.sig" \
  "/tmp/$PORTABLE_NAME" "/tmp/$SETUP_NAME" "$MANIFEST_IN"; do
  [ -s "$file" ] || { echo "missing staged release file: $file" >&2; exit 1; }
done

node - "$MANIFEST_IN" "$VERSION" "$MAC_NAME" "$WINDOWS_NAME" <<'NODE'
const fs = require('node:fs');
const [manifestPath, version, macName, windowsName] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const mac = manifest.platforms?.['darwin-aarch64'];
const windows = manifest.platforms?.['windows-x86_64'];
const base = 'https://qbank.creart.top:8013/v1/desktop/releases';
if (manifest.version !== version || !mac || !windows) throw new Error('release manifest version or platform entries are invalid');
if (mac.url !== `${base}/${macName}` || windows.url !== `${base}/windows/${version}/${windowsName}`) {
  throw new Error('release manifest points outside the expected versioned asset paths');
}
if (mac.signature !== fs.readFileSync(`/tmp/${macName}.sig`, 'utf8').trim()) throw new Error('macOS signature differs from manifest');
if (windows.signature !== fs.readFileSync(`/tmp/${windowsName}.sig`, 'utf8').trim()) throw new Error('Windows signature differs from manifest');
NODE

mkdir -p "$RELEASE" "$MACOS_RELEASE" "$WINDOWS_RELEASE" "$BACKUPS"
chown root:caddy "$ROOT" "$RELEASES" "$RELEASE" "$RELEASES/macos" "$MACOS_RELEASE" "$RELEASES/windows" "$WINDOWS_RELEASE" 2>/dev/null || true
chmod 0750 "$ROOT" "$RELEASES" "$RELEASE" "$RELEASES/macos" "$MACOS_RELEASE" "$RELEASES/windows" "$WINDOWS_RELEASE"

install_immutable() {
  source=$1
  destination=$2
  mode=$3
  if [ -e "$destination" ]; then
    cmp -s "$source" "$destination" || { echo "immutable release asset differs: $destination" >&2; exit 1; }
  else
    install -o root -g caddy -m "$mode" "$source" "$destination"
  fi
}

install_immutable "$MAC_IN" "$RELEASE/$MAC_NAME" 0640
install_immutable "$MAC_IN.sig" "$RELEASE/$MAC_NAME.sig" 0640
install_immutable "$MAC_DMG_IN" "$MACOS_RELEASE/$MAC_DMG_NAME" 0640
install_immutable "$WINDOWS_IN" "$WINDOWS_RELEASE/$WINDOWS_NAME" 0640
install_immutable "$WINDOWS_IN.sig" "$WINDOWS_RELEASE/$WINDOWS_NAME.sig" 0640
install_immutable "/tmp/$SETUP_NAME" "$WINDOWS_RELEASE/$SETUP_NAME" 0640
install_immutable "/tmp/$PORTABLE_NAME" "$WINDOWS_RELEASE/$PORTABLE_NAME" 0640

# Preserve the flat macOS archive URL used by already-installed clients.
for name in "$MAC_NAME" "$MAC_NAME.sig"; do
  if [ -e "$RELEASES/$name" ]; then
    cmp -s "$RELEASE/$name" "$RELEASES/$name" || { echo "flat compatibility asset differs: $RELEASES/$name" >&2; exit 1; }
  else
    ln "$RELEASE/$name" "$RELEASES/$name"
  fi
done

(cd "$RELEASE" && sha256sum "$MAC_NAME" "$MAC_NAME.sig" \
  "../macos/$VERSION/$MAC_DMG_NAME" \
  "../windows/$VERSION/$WINDOWS_NAME" "../windows/$VERSION/$WINDOWS_NAME.sig" \
  "../windows/$VERSION/$SETUP_NAME" "../windows/$VERSION/$PORTABLE_NAME" > SHA256SUMS)
chown root:caddy "$RELEASE/SHA256SUMS"
chmod 0640 "$RELEASE/SHA256SUMS"

if [ -f "$DOMAIN_CONFIG" ]; then
  if ! grep -q '/v1/desktop/releases/\*' "$DOMAIN_CONFIG" || ! grep -q '/v1/desktop/\*' "$DOMAIN_CONFIG"; then
    echo "Caddy does not have the desktop release routes; latest.json was not changed." >&2
    exit 1
  fi
fi

PREVIOUS_LATEST=''
if [ -e "$ROOT/latest.json" ]; then
  PREVIOUS_LATEST="$BACKUPS/$(date -u +%Y%m%dT%H%M%SZ)-desktop-latest.json"
  cp -p "$ROOT/latest.json" "$PREVIOUS_LATEST"
fi
install -o root -g caddy -m 0640 "$MANIFEST_IN" "$ROOT/.latest-$VERSION.json"
mv -f "$ROOT/.latest-$VERSION.json" "$ROOT/latest.json"

restore_latest() {
  if [ -n "$PREVIOUS_LATEST" ]; then
    cp -p "$PREVIOUS_LATEST" "$ROOT/.latest-rollback.json"
    mv -f "$ROOT/.latest-rollback.json" "$ROOT/latest.json"
  else
    rm -f "$ROOT/latest.json"
  fi
}

if command -v curl >/dev/null 2>&1; then
  verified=0
  attempt=0
  while [ "$attempt" -lt 6 ]; do
    attempt=$((attempt + 1))
    if curl --fail --silent --show-error --resolve qbank.creart.top:8443:127.0.0.1 \
      https://qbank.creart.top:8443/v1/desktop/latest.json -o /tmp/qbank-desktop-update-check.json \
      && curl --fail --silent --show-error --head --resolve qbank.creart.top:8443:127.0.0.1 \
        "https://qbank.creart.top:8443/v1/desktop/releases/$MAC_NAME" >/dev/null \
      && curl --fail --silent --show-error --head --resolve qbank.creart.top:8443:127.0.0.1 \
        "https://qbank.creart.top:8443/v1/desktop/releases/windows/$VERSION/$WINDOWS_NAME" >/dev/null; then
      verified=1
      break
    fi
    sleep 1
  done
  if [ "$verified" -ne 1 ]; then
    restore_latest
    echo 'Caddy did not serve the new manifest and both updater archives over HTTPS.' >&2
    exit 1
  fi
  if ! node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(m.version!==process.argv[2])process.exit(1)' \
    /tmp/qbank-desktop-update-check.json "$VERSION"; then
    restore_latest
    echo 'Caddy served a different update manifest; restored the previous latest.json.' >&2
    exit 1
  fi
else
  echo 'curl unavailable; host-side HTTPS fetch was skipped.'
fi

echo "Desktop release $VERSION published at $RELEASE"
echo "latest manifest: $ROOT/latest.json"
