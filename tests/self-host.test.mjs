import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const runtime = '../artifacts/self-host/qbank-auth/';
const { createFileStore } = await import(`${runtime}fs-store.cjs`);
const { createLocalServer } = await import(`${runtime}local-server.cjs`);

const bankId = 'ad50971f-66af-51c2-bb0e-dc798b03b369';
const batchId = '00000000-0000-4000-8000-000000000001';

function localRequest(server, method, path) {
  const req = new EventEmitter();
  req.method = method;
  req.url = path;
  req.headers = {host: '127.0.0.1'};
  return new Promise((resolve, reject) => {
    const response = {statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body = '') {
      try { resolve({status: this.statusCode, headers: this.headers, data: JSON.parse(body || 'null')}); }
      catch (error) { reject(error); }
    }};
    try { server.listeners('request')[0](req, response); } catch (error) { reject(error); }
  });
}

test('filesystem store keeps immutable state and idempotent submissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbank-store-'));
  const store = createFileStore({ root });
  const state = { format: 'qbank-state-1', bank_id: bankId, name: '测试库', revision: 1,
    release_version: 1, formal: [], pending: [], resolved: [], batches: [], merge_history: [], updated_at: new Date().toISOString() };
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

test('local HTTP host handler preserves health and catalog routes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qbank-host-'));
  const env = { QBANK_STORAGE_ROOT: root, QBANK_BIND_HOST: '127.0.0.1',
    QBANK_BANKS: JSON.stringify([{ bank_id: bankId, name: '测试库' }]), QBANK_SYNC_ENABLED: 'true',
    QBANK_UPLOAD_ENABLED: 'false', QBANK_ALLOWED_ORIGINS: '[]', QBANK_DEVELOPERS: '{}', QBANK_MAINTAINERS: '[]',
    QBANK_CLOUD_CREATORS: '[]', WX_APP_ID: 'wx22c8135ae81d3acc', WX_APP_SECRET: 'test', QBANK_SESSION_SECRET: 'a'.repeat(64) };
  const {server} = createLocalServer({env});
  const health = await localRequest(server, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.service, 'qbank-auth');
  assert.equal(health.data.auth_configured, true);
  const catalog = await localRequest(server, 'GET', '/v1/catalog');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.banks[0].bank_id, bankId);
  assert.equal(catalog.data.banks[0].revision, 0);
  await fs.rm(root, { recursive: true, force: true });
});
