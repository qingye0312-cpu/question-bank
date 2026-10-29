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
STAGING="${QBANK_RELEASE_STAGING:-/tmp}"
MAC_IN="$STAGING/$MAC_NAME"
MAC_DMG_IN="$STAGING/$MAC_DMG_NAME"
WINDOWS_IN="$STAGING/$WINDOWS_NAME"
MANIFEST_IN="$STAGING/latest.json"
BACKUPS=/var/backups/qbank-desktop-updates
DOMAIN_CONFIG=/etc/caddy/qbank-domain.caddy
DESKTOP_RELEASES_TO_KEEP="${QBANK_DESKTOP_RELEASES_TO_KEEP:-2}"

for file in "$MAC_IN" "$MAC_IN.sig" "$MAC_DMG_IN" "$WINDOWS_IN" "$WINDOWS_IN.sig" \
  "$STAGING/$PORTABLE_NAME" "$STAGING/$SETUP_NAME" "$MANIFEST_IN"; do
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
if (mac.signature !== fs.readFileSync(`${process.env.QBANK_RELEASE_STAGING || '/tmp'}/${macName}.sig`, 'utf8').trim()) throw new Error('macOS signature differs from manifest');
if (windows.signature !== fs.readFileSync(`${process.env.QBANK_RELEASE_STAGING || '/tmp'}/${windowsName}.sig`, 'utf8').trim()) throw new Error('Windows signature differs from manifest');
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
install_immutable "$STAGING/$SETUP_NAME" "$WINDOWS_RELEASE/$SETUP_NAME" 0640
install_immutable "$STAGING/$PORTABLE_NAME" "$WINDOWS_RELEASE/$PORTABLE_NAME" 0640

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

HOST_UPDATE_VERIFIED=0
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
  HOST_UPDATE_VERIFIED=1
else
  echo 'curl unavailable; host-side HTTPS fetch was skipped.'
fi

# Prune only after the new manifest and both updater archives pass host-side HTTPS checks.
if [ "$HOST_UPDATE_VERIFIED" -eq 1 ] && [ -n "$PREVIOUS_LATEST" ]; then
  node - "$RELEASES" "$BACKUPS" "$VERSION" "$DESKTOP_RELEASES_TO_KEEP" "$PREVIOUS_LATEST" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const cleanup = () => {
const [releaseRoot, backupsRoot, currentVersion, keepRaw, previousLatest] = process.argv.slice(2);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const parseVersion = version => {
  const match = versionPattern.exec(version);
  return match ? match.slice(1).map(BigInt) : null;
};
const compareVersions = (left, right) => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
};
const keepCount = Number(keepRaw);
if (!parseVersion(currentVersion)) throw new Error('Cleanup received an invalid current version.');
if (!Number.isSafeInteger(keepCount) || keepCount < 1 || keepCount > 20) {
  throw new Error('Desktop release retention must be an integer from 1 to 20.');
}

const hasCompleteRelease = version => {
  const files = [
    path.join(releaseRoot, version, 'SHA256SUMS'),
    path.join(releaseRoot, version, `qbank-macos-arm64-${version}.app.tar.gz`),
    path.join(releaseRoot, version, `qbank-macos-arm64-${version}.app.tar.gz.sig`),
    path.join(releaseRoot, 'macos', version, `题库_${version}_macOS_arm64.dmg`),
    path.join(releaseRoot, 'windows', version, `qbank-windows-x64-${version}.nsis.zip`),
    path.join(releaseRoot, 'windows', version, `qbank-windows-x64-${version}.nsis.zip.sig`),
    path.join(releaseRoot, 'windows', version, '题库_windows_x64_setup.exe'),
    path.join(releaseRoot, 'windows', version, '题库_windows_x64_portable.exe'),
  ];
  return files.every(file => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  });
};

if (!hasCompleteRelease(currentVersion)) {
  console.log('Cleanup skipped: the current release assets are incomplete.');
  return;
}

const backupPattern = /^\d{8}T\d{6}Z-desktop-latest\.json$/;
const previousName = path.basename(previousLatest);
const backupsRootPath = path.resolve(backupsRoot);
if (path.dirname(path.resolve(previousLatest)) !== backupsRootPath || !backupPattern.test(previousName)) {
  console.log('Cleanup skipped: the previous manifest path is outside the backup directory.');
  return;
}
const backups = fs.readdirSync(backupsRoot)
  .filter(name => backupPattern.test(name))
  .sort()
  .reverse();
if (!backups.includes(previousName)) {
  console.log('Cleanup skipped: the previous manifest backup is missing.');
  return;
}

const candidateBackups = [previousName, ...backups.filter(name => name !== previousName)];
const retainedVersions = new Set([currentVersion]);
const retainedBackups = new Set();
for (const name of candidateBackups) {
  if (retainedVersions.size >= keepCount) break;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(backupsRoot, name), 'utf8'));
  } catch {
    continue;
  }
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!parseVersion(version) || retainedVersions.has(version) || !hasCompleteRelease(version)) continue;
  retainedVersions.add(version);
  retainedBackups.add(name);
}

if (retainedVersions.size < keepCount) {
  console.log(`Cleanup skipped: only ${retainedVersions.size} complete release version(s) are available; preserving prior assets.`);
  return;
}

const directories = new Set();
for (const parent of [releaseRoot, path.join(releaseRoot, 'macos'), path.join(releaseRoot, 'windows')]) {
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (entry.isDirectory() && parseVersion(entry.name)) directories.add(entry.name);
  }
}
const compatibilityArchivePattern = /^qbank-macos-arm64-(\d+(?:\.\d+){2})\.app\.tar\.gz(?:\.sig)?$/;
for (const name of fs.readdirSync(releaseRoot)) {
  const match = compatibilityArchivePattern.exec(name);
  if (match && parseVersion(match[1])) directories.add(match[1]);
}

const obsoleteVersions = [...directories].filter(version => !retainedVersions.has(version)).sort(compareVersions);
for (const version of obsoleteVersions) {
  for (const target of [
    path.join(releaseRoot, version),
    path.join(releaseRoot, 'macos', version),
    path.join(releaseRoot, 'windows', version),
    path.join(releaseRoot, `qbank-macos-arm64-${version}.app.tar.gz`),
    path.join(releaseRoot, `qbank-macos-arm64-${version}.app.tar.gz.sig`),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  console.log(`Removed expired desktop release ${version}.`);
}

for (const name of backups) {
  if (retainedBackups.has(name)) continue;
  fs.rmSync(path.join(backupsRoot, name), { force: true });
  console.log(`Removed expired latest.json backup ${name}.`);
}
console.log(`Retained desktop releases: ${[...retainedVersions].join(', ')}.`);
};
cleanup();
NODE
else
  echo 'Host verification or previous latest.json backup unavailable; cleanup skipped to preserve existing release assets.'
fi

echo "Desktop release $VERSION published at $RELEASE"
echo "latest manifest: $ROOT/latest.json"
