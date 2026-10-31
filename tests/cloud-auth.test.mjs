import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { parseDelta, validateStandardQuestion, parseModelReply, sha256 } from '../desktop/shared/intake.ts';
import { encodeUpload } from '../tools/encode-upload.mjs';

const require = createRequire(import.meta.url);
const { createHandler, LIMITS } = require('../cloud/qbank-auth/service.cjs');
const fixture = fs.readFileSync(new URL('./fixtures/intake/mobile-delta.json', import.meta.url), 'utf8');
const packet = JSON.parse(fixture);
const bankId = packet.bank_id;
const key = 'b'.repeat(64);

function setup() {
  const states = new Map(), records = new Map(), operationFiles = new Map();
  let time = Date.now();
  const env = {
    QBANK_SESSION_SECRET: 'a'.repeat(64),
    QBANK_BANKS: JSON.stringify([{ bank_id: bankId, name: packet.name }]), QBANK_UPLOAD_ENABLED: 'true', QBANK_SYNC_ENABLED: 'true',
    QBANK_CLOUD_CREATORS: JSON.stringify(['maintainer-tests']),
    QBANK_MAINTAINERS: JSON.stringify([{ id: 'maintainer-tests', key_sha256: sha256(key), grants: { [bankId]: ['upload', 'merge'] } }]),
  };
  const store = {
    async readState(id) { return states.get(id) ? structuredClone(states.get(id)) : null; },
    async readStateAt(id, revision) { return states.get(`${id}/${revision}`) ? structuredClone(states.get(`${id}/${revision}`)) : null; },
    async listStates(id) { return [...states.values()].filter(s => s.bank_id === id).sort((a, b) => b.revision - a.revision).map(s=>structuredClone(s)); },
    async createState(state) { const current = states.get(state.bank_id); if (current && current.revision >= state.revision) return false; states.set(state.bank_id, structuredClone(state)); states.set(`${state.bank_id}/${state.revision}`, structuredClone(state)); return true; },
    async createSubmission(path, record) { if (records.has(path)) return { record: records.get(path), created: false }; records.set(path, record); return { record, created: true }; },
    async readOperations(id) { return operationFiles.has(id) ? structuredClone(operationFiles.get(id)) : null; },
    async writeOperations(value) { operationFiles.set(value.bank_id, structuredClone(value)); return true; },
  };
  const handler = createHandler({ env: () => env, store, clock: () => time, parseDelta, validateStandardQuestion, parseModelReply });
  const call = async (method, path, body, token) => {
    const response = await handler({ httpMethod: method, path, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.statusCode, data: JSON.parse(response.body) };
  };
  const login = async () => (await call('POST', '/v1/auth/desktop', { key })).data.access_token;
  return { env, states, records, call, login, advance: seconds => { time += seconds * 1000; } };
}

function confirmed(text = fixture) { return encodeUpload(text); }

test('health reports the self-hosted current protocol and never exposes secrets', async () => {
  const s = setup();
  const health = await s.call('GET', '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.data.auth_checks, { QBANK_SESSION_SECRET: 'ok', QBANK_BANKS: 'ok' });
  assert.ok(health.data.capabilities.includes('confirmed-upload-v1'));
  assert.equal((await s.call('POST', '/v1/auth/wechat-login', { login_code: 'removed' })).status, 404);
  assert.ok(!JSON.stringify(health).includes(s.env.QBANK_SESSION_SECRET));
});

test('desktop auth is required and upload accepts only the current confirmed package', async () => {
  const s = setup();
  assert.equal((await s.call('POST', '/v1/uploads', confirmed())).status, 401);
  const token = await s.login();
  assert.equal((await s.call('POST', '/v1/uploads', confirmed(), token)).status, 409);
  assert.equal(s.records.size,0);
  const seed = { ...JSON.parse(packet.payload), question_id: randomUUID(), stem: 'Initial base question', status: 'verified' };
  assert.equal((await s.call('POST', `/v1/banks/${bankId}/seed`, { base_revision: 0, questions: [seed] }, token)).status, 200);
  const uploaded = await s.call('POST', '/v1/uploads', confirmed(), token);
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.data.receipt.status, 'merged');
  assert.equal((await s.call('POST', '/v1/uploads', confirmed(), token)).data.receipt.status, 'duplicate');
  assert.equal((await s.call('POST', '/v1/uploads', { format: 'qbank-upload-1', data: 'removed' }, token)).status, 422);
});

test('bad packages and stale sessions fail closed without creating records', async () => {
  const s = setup(), token = await s.login(), good = confirmed();
  for (const value of [{ ...good, package: { ...good.package, data: `${good.package.data}$` } }, { ...good, package: { ...good.package, sha256: '0'.repeat(64) } }])
    assert.equal((await s.call('POST', '/v1/uploads', value, token)).status, 422);
  assert.equal((await s.call('GET', '/v1/me', undefined, `${token}x`)).status, 401);
  s.advance(LIMITS.sessionSeconds);
  assert.equal((await s.call('GET', '/v1/me', undefined, token)).status, 401);
  assert.equal(s.records.size, 0);
});

test('disabled version sync cannot accept a submission into a pending queue',async()=>{
 const s=setup(),token=await s.login();s.env.QBANK_SYNC_ENABLED='false';
 const result=await s.call('POST','/v1/uploads',confirmed(),token);
 assert.equal(result.status,503);assert.equal(result.data.error.code,'SYNC_DISABLED');assert.equal(s.records.size,0);
});
