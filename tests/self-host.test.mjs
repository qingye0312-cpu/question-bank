import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const runtime = '../artifacts/self-host/qbank-auth/';
const { createFileStore } = await import(`${runtime}fs-store.cjs`);
const { createLocalServer } = await import(`${runtime}local-server.cjs`);

const bankId = 'ad50971f-66af-51c2-bb0e-dc798b03b369';
const batchId = '00000000-0000-4000-8000-000000000001';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false, headers: { connection: 'close' } }, response => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try { resolve(JSON.parse(chunks.join(''))); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
}

test('filesystem store keeps immutable state and idempotent submissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbank-store-'));
  const store = createFileStore({ root });
  const state = { format: 'qbank-state-1', bank_id: bankId, name: '测试库', revision: 1,
    release_version: 1, formal: [], pending: [], resolved: [], batches: [], updated_at: new Date().toISOString() };
  assert.equal(await store.createState(state), true);
  assert.equal(await store.createState(state), false);
  assert.equal((await store.readState(bankId)).revision, 1);
  const record = { format: 'qbank-submission-1', bank_id: bankId, batch_id: batchId, sha256: 'a'.repeat(64), package: {} };
  assert.equal((await store.createSubmission(`inbox/${bankId}/${batchId}.json`, record)).created, true);
  const retry = await store.createSubmission(`inbox/${bankId}/${batchId}.json`, record);
  assert.equal(retry.created, false);
  assert.equal(retry.record.batch_id, batchId);
  await assert.rejects(() => store.createState({ ...state, revision: 0 }), /Invalid state revision/);
  await fs.rm(root, { recursive: true, force: true });
});

test('local HTTP host preserves health and catalog routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbank-host-'));
  const env = { QBANK_STORAGE_ROOT: root, QBANK_BIND_HOST: '127.0.0.1', QBANK_PORT: '0',
    QBANK_BANKS: JSON.stringify([{ bank_id: bankId, name: '测试库' }]), QBANK_SYNC_ENABLED: 'true',
    QBANK_UPLOAD_ENABLED: 'false', QBANK_ALLOWED_ORIGINS: '[]', QBANK_DEVELOPERS: '{}', QBANK_MAINTAINERS: '[]',
    QBANK_CLOUD_CREATORS: '[]', WX_APP_ID: 'wx22c8135ae81d3acc', WX_APP_SECRET: 'test', QBANK_SESSION_SECRET: 'a'.repeat(64) };
  const { server } = createLocalServer({ env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const health = await getJson(`${base}/health`);
  assert.equal(health.service, 'qbank-auth');
  assert.equal(health.auth_configured, true);
  const catalog = await getJson(`${base}/v1/catalog`);
  assert.equal(catalog.banks[0].bank_id, bankId);
  assert.equal(catalog.banks[0].revision, 0);
  await new Promise(resolve => server.close(resolve));
  // undici may keep an idle keep-alive socket after the last fetch. Close it
  // explicitly so the test runner can terminate cleanly on Node 24/macOS.
  server.closeAllConnections?.();
  await new Promise(resolve => setImmediate(resolve));
  await fs.rm(root, { recursive: true, force: true });
});
