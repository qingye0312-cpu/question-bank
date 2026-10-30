import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Caddyfile.domain declares only the canonical domain', () => {
  const text = read('tools/self-host/Caddyfile.domain');
  assert.match(text, /https:\/\/qbank\.acharrystar\.top:8443/);
  assert.doesNotMatch(text, /qbank\.creart\.top/);
  assert.match(text, /import qbank-routes/);
});

test('deployment scripts default to the canonical domain', () => {
  const scripts = [
    'tools/self-host/install-domain-certificate.sh',
    'tools/self-host/install-domain-certificate-renewal.sh',
    'tools/self-host/install-desktop-update-release.sh',
    'tools/self-host/install-download-page.sh',
    'tools/self-host/install-fastdownload.sh',
    'tools/self-host/deploy-domain-tls.sh',
  ];
  for (const script of scripts) {
    const text = read(script);
    assert.match(text, /acharrystar\.top/, `${script} must use the canonical domain`);
    assert.doesNotMatch(text, /qbank\.creart\.top/, `${script} must not default to the legacy domain`);
    assert.doesNotMatch(text, /8\.141\.124\.97/, `${script} must not default to the legacy IP`);
  }
});

test('release and client defaults use the canonical domain', () => {
  const service = JSON.parse(read('desktop/shared/desktop-service.json'));
  assert.equal(service.origin, 'https://qbank.acharrystar.top:8013');

  const manifest = read('tools/desktop-release/create-manifest.mjs');
  const macos = read('tools/macos/release.mjs');
  const workflow = read('.github/workflows/desktop-release.yml');
  assert.match(manifest, /qbank\.acharrystar\.top:8013\/v1\/desktop\/releases/);
  assert.match(macos, /qbank\.acharrystar\.top:8013\/v1\/desktop\/latest\.json/);
  assert.match(workflow, /qbank\.acharrystar\.top:8013\/v1\/desktop\/latest\.json/);
  assert.doesNotMatch(workflow, /qbank\.creart\.top/);
});

test('desktop client relies on public TLS instead of the legacy embedded CA', () => {
  const text = read('desktop/src-tauri/src/cloud/transport.rs');
  assert.doesNotMatch(text, /qbank-pve-root-ca\.pem/);
  assert.doesNotMatch(text, /tls_certs_only/);
  assert.equal(fs.existsSync(path.join(root, 'desktop/src-tauri/resources/qbank-pve-root-ca.pem')), false);
});

test('fastdownload server and TLS probe use the canonical domain', () => {
  for (const file of ['tools/self-host/fastdownload-server/server.mjs', 'tools/self-host/check-public-tls.mjs']) {
    const text = read(file);
    assert.match(text, /qbank\.acharrystar\.top:8013/);
    assert.doesNotMatch(text, /qbank\.creart\.top/);
  }
});

test('deploy-domain-tls.sh installs renewal and verifies public TLS', () => {
  const text = read('tools/self-host/deploy-domain-tls.sh');
  assert.match(text, /install-domain-certificate-renewal/);
  assert.match(text, /check-public-tls\.mjs/);
  assert.match(text, /rc-service caddy checkconfig/);
});
