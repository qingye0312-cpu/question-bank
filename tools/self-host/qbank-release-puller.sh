#!/bin/sh
set -eu

# Invoked by the trusted release SSH command. The proxy is read from a
# root-only environment file and is used only by GitHub download requests.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

REPOSITORY=qingye0312-cpu/question-bank
ROOT=/var/lib/qbank-desktop-updates
STAGING_ROOT="$ROOT/staging"
BACKUPS=/var/backups/qbank-desktop-updates
CONFIG=/etc/qbank-release-puller.env
INSTALLER=/usr/local/sbin/qbank-install-desktop-update
LOG_DIR=/var/log/qbank-release-puller

usage() {
  echo "Usage: $0 <version>" >&2
  exit 2
}

fail() {
  echo "qbank release pull failed: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
VERSION=$1
printf '%s\n' "$VERSION" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' \
  || fail "invalid version: $VERSION"
[ "$(id -u)" -eq 0 ] || fail 'root is required'

# OpenRC starts this task as root; an atomic directory lock makes retries
# idempotent without requiring util-linux or a daemon.
LOCK=/run/qbank-release-puller.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  lock_pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    fail 'another release pull is already running'
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK" || fail 'could not acquire release pull lock'
fi
printf '%s\n' "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT HUP INT TERM

if [ -f "$CONFIG" ]; then
  # The file must be root-owned and mode 0600. Only proxy variables are read.
  [ "$(stat -c %u "$CONFIG")" -eq 0 ] || fail "$CONFIG must be owned by root"
  [ "$(stat -c %a "$CONFIG")" = 600 ] || fail "$CONFIG must have mode 0600"
  set -a
  . "$CONFIG"
  set +a
fi

for variable in HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY; do
  eval "value=\${$variable:-}"
  [ -z "$value" ] || printf '%s is configured\n' "$variable"
done

command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required'
command -v node >/dev/null 2>&1 || fail 'node is required'
[ -x "$INSTALLER" ] || fail "missing installer: $INSTALLER"

STAGING="$STAGING_ROOT/$VERSION"
LOG="$LOG_DIR/$VERSION.log"
mkdir -p "$STAGING" "$BACKUPS" "$LOG_DIR"
chmod 0700 "$STAGING_ROOT" "$STAGING" "$LOG_DIR"

exec >>"$LOG" 2>&1
echo "pulling GitHub release v$VERSION from $REPOSITORY"

API_URL="https://api.github.com/repos/$REPOSITORY/releases/tags/v$VERSION"
API_FILE="$STAGING/release.json"
AUTH_FILE="$STAGING/.github-auth"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" > "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
fi

curl_retry() {
  if [ -f "$AUTH_FILE" ]; then
    curl --location --fail --silent --show-error --retry 10 --retry-all-errors \
      --retry-delay 3 --connect-timeout 30 --max-time 1800 \
      --config "$AUTH_FILE" "$@"
  else
    curl --location --fail --silent --show-error --retry 10 --retry-all-errors \
      --retry-delay 3 --connect-timeout 30 --max-time 1800 "$@"
  fi
}

if ! curl_retry --header 'Accept: application/vnd.github+json' \
  --header 'X-GitHub-Api-Version: 2022-11-28' --output "$API_FILE" "$API_URL"; then
  fail "GitHub Release API request failed; check proxy and GITHUB_TOKEN in $CONFIG"
fi

node - "$API_FILE" "$VERSION" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!release || release.draft || release.prerelease || release.tag_name !== `v${version}`)
  throw new Error('release identity is not a published final version');
if (!Array.isArray(release.assets) || !release.assets.length)
  throw new Error('release has no assets');
for (const asset of release.assets) {
  if (!asset || typeof asset.name !== 'string' || !asset.name || typeof asset.url !== 'string')
    throw new Error('invalid release asset metadata');
}
NODE

node - "$API_FILE" "$STAGING" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [apiFile, staging] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
const version = release.tag_name.slice(1);
const requiredOutputs = [
  'latest.json',
  'SHA256SUMS',
  `qbank-${version}-macos-arm64-app.tar.gz`,
  `qbank-${version}-macos-arm64-app.tar.gz.sig`,
  `qbank-${version}-windows-x64-nsis.zip`,
  `qbank-${version}-windows-x64-nsis.zip.sig`,
  `qbank-${version}-macos-arm64.dmg`,
  `qbank-${version}-windows-x64-portable.exe`,
  `qbank-${version}-windows-x64-setup.exe`,
];
const outputFor = asset => {
  if (requiredOutputs.includes(asset.name)) return asset.name;
  if (asset.name === `_${version}_macOS_arm64.dmg` || asset.name.endsWith(`_${version}_macOS_arm64.dmg`))
    return `qbank-${version}-macos-arm64.dmg`;
  if (asset.name === '_windows_x64_portable.exe' || asset.name === 'windows_x64_portable.exe')
    return `qbank-${version}-windows-x64-portable.exe`;
  if (asset.name === '_windows_x64_setup.exe' || asset.name === 'windows_x64_setup.exe')
    return `qbank-${version}-windows-x64-setup.exe`;
  if (asset.name === `题库_${version}_macOS_arm64.dmg`)
    return `qbank-${version}-macos-arm64.dmg`;
  if (asset.name === '题库_windows_x64_portable.exe')
    return `qbank-${version}-windows-x64-portable.exe`;
  if (asset.name === '题库_windows_x64_setup.exe')
    return `qbank-${version}-windows-x64-setup.exe`;
  return asset.name;
};
const outputs = new Set();
const rows = [];
for (const asset of release.assets) {
  if (asset.name === path.basename(asset.name) && !asset.name.includes('\0')) {
    const output = outputFor(asset);
    if (requiredOutputs.includes(output) && output === path.basename(output) && !outputs.has(output)) {
      outputs.add(output);
      const digest = typeof asset.digest === 'string' ? asset.digest : '';
      if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`missing GitHub digest for ${asset.name}`);
      rows.push(`${asset.name}\t${output}\t${asset.url}\t${digest.slice(7)}`);
    }
  }
}
for (const output of requiredOutputs) if (!outputs.has(output)) throw new Error(`missing release asset after name normalization: ${output}`);
fs.writeFileSync(path.join(staging, 'assets.tsv'), `${rows.join('\n')}\n`, {mode: 0o600});
NODE

while IFS="$(printf '\t')" read -r source output url digest; do
  [ -n "$source" ] || continue
  target="$STAGING/$output"
  if [ -s "$target" ]; then
    actual=$(sha256sum "$target" | awk '{print $1}')
    if [ "$actual" = "$digest" ]; then
      [ "$source" = "$output" ] || ln -sf "$output" "$STAGING/$source"
      echo "already downloaded $output"
      continue
    fi
  fi
  echo "downloading $source"
  if ! curl_retry --header 'Accept: application/octet-stream' --continue-at - --output "$target" "$url"; then
    fail "download failed for $source"
  fi
  actual=$(sha256sum "$target" | awk '{print $1}')
  [ "$actual" = "$digest" ] || fail "GitHub digest mismatch for $output"
  [ "$source" = "$output" ] || ln -sf "$output" "$STAGING/$source"
done < "$STAGING/assets.tsv"

while IFS= read -r line; do
  set -- $line
  [ "$#" -eq 2 ] || fail "invalid SHA256SUMS line: $line"
  file=$2
  file=${file#\*}
  expected=$1
  [ -s "$STAGING/$file" ] || fail "missing downloaded asset: $file"
  actual=$(sha256sum "$STAGING/$file" | awk '{print $1}')
  [ "$actual" = "$expected" ] || fail "SHA256SUMS mismatch for $file"
done < "$STAGING/SHA256SUMS"

echo "all release assets verified"
QBANK_RELEASE_VERSION="$VERSION" \
QBANK_RELEASE_STAGING="$STAGING" \
QBANK_DESKTOP_RELEASES_TO_KEEP="${QBANK_DESKTOP_RELEASES_TO_KEEP:-2}" \
  "$INSTALLER"

echo "release v$VERSION pulled and installed"
