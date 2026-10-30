import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = path.join(root, 'tools/self-host/qbank-release-puller.sh');

test('release puller is executable and rejects unsafe versions before network access', () => {
  const mode = fs.statSync(script).mode & 0o777;
  assert.ok(mode & 0o100, 'puller must be executable');
  for (const value of ['', '1.2', 'v1.2.3', '1.2.3;id', '../1.2.3', '1.2.3 extra']) {
    assert.throws(() => execFileSync(script, value ? [value] : [], {stdio: 'pipe'}), /invalid version|Usage/);
  }
});

test('release puller contains no polling loop and uses an explicit release API', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /REPOSITORY=qingye0312-cpu\/question-bank/);
  assert.match(text, /API_URL="https:\/\/api\.github\.com\/repos\/\$REPOSITORY\/releases\/tags\/v\$VERSION"/);
  assert.match(text, /GITHUB_TOKEN/);
  assert.match(text, /Accept: application\/octet-stream/);
  assert.doesNotMatch(text, /while\s+true|sleep\s+[0-9]/);
  assert.match(text, /--continue-at -/);
  assert.match(text, /SHA256SUMS/);
  assert.match(text, /qbank-install-desktop-update/);
  assert.match(text, /qbank-\$\{version\}-macos-arm64\.dmg/);
  assert.match(text, /qbank-\$\{version\}-windows-x64-setup\.exe/);
  assert.match(text, /qbank-\$\{version\}-windows-x64-portable\.exe/);
});

test('desktop workflow triggers the server puller instead of uploading release assets', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/desktop-release.yml'), 'utf8');
  assert.match(workflow, /qbank-release-puller/);
  assert.doesNotMatch(workflow, /\bscp\b/);
  assert.doesNotMatch(workflow, /release-assets\/\*.*root@/);
});

test('release assets use qbank-version-system-arch names', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/desktop-release.yml'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'tools/desktop-release/create-manifest.mjs'), 'utf8');
  // macOS steps run in bash; the Windows steps run in PowerShell.
  assert.match(workflow, /qbank-\$\{version\}-macos-arm64-app\.tar\.gz/);
  assert.match(workflow, /qbank-\$\{version\}-macos-arm64\.dmg/);
  assert.match(workflow, /qbank-\$version-windows-x64-nsis\.zip/);
  assert.match(workflow, /qbank-\$version-windows-x64-setup\.exe/);
  assert.match(workflow, /qbank-\$version-windows-x64-portable\.exe/);
  assert.match(manifest, /qbank-\$\{version\}-macos-arm64-app\.tar\.gz/);
  assert.match(manifest, /qbank-\$\{version\}-windows-x64-nsis\.zip/);
});
