import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { parseDelta, parseModelReply } from '../shared/intake.ts';
import { encodeUpload } from '../tools/cloud/encode-upload.mjs';

const require = createRequire(import.meta.url);
const { createHandler, LIMITS, sha256 } = require('../cloud/qbank-auth/service.cjs');
const { createCosStore, createWechatExchange } = require('../cloud/qbank-auth/adapters.cjs');
const fixture = fs.readFileSync(new URL('./fixtures/intake/mobile-delta.json', import.meta.url), 'utf8');
const packet = JSON.parse(fixture);
const developer = 'openid-developer-for-tests';
const guest = 'openid-guest-for-tests';
const bank2 = '00000000-0000-4000-8000-000000000099';
const envConfig = () => ({ WX_APP_ID: 'wx0000000000000000', WX_APP_SECRET: 'test-only-app-secret',
  QBANK_SESSION_SECRET: 'a'.repeat(64), QBANK_BANKS: JSON.stringify([
    { bank_id: packet.bank_id, name: packet.name }, { bank_id: bank2, name: '另一个题库' }]),
  QBANK_DEVELOPERS: JSON.stringify({ [developer]: [packet.bank_id] }), QBANK_UPLOAD_ENABLED: 'true' });
function setup(options = {}) {
  const env = envConfig(), records = new Map(); let time = Date.now(), writes = 0;
  const store = { async createSubmission(key, record) {
    if (records.has(key)) return { record: records.get(key), created: false };
    writes++; records.set(key, record); return { record, created: true };
  } };
  const handler = createHandler({ env: () => env, clock: () => time, store,
    exchangeCode: async ({ code }) => ({ openid: code === 'developer-code' ? developer : guest, session_key: 'never-return' }),
    parseDelta, parseModelReply, ...options });
  const call = async (method, path, body, token, extra = {}) => {
    const response = await handler({ httpMethod: method, path,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(extra.headers || {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...extra });
    return { status: response.statusCode, headers: response.headers, data: JSON.parse(response.body) };
  };
  const login = async () => (await call('POST', '/v1/auth/wechat', { code: 'developer-code' })).data.access_token;
  return { env, records, call, login, handler, writes: () => writes, advance: seconds => { time += seconds * 1000; } };
}
function changePacket(edit) {
  const d = structuredClone(packet), q = JSON.parse(d.payload);
  edit(d, q); d.payload = JSON.stringify(q) + '\n'; d.sha256 = sha256(d.payload);
  return encodeUpload(JSON.stringify(d));
}

test('health works before secrets are configured; protected routes fail closed', async () => {
  const s = setup(); delete s.env.WX_APP_SECRET;
  const health = await s.call('GET', '/health');
  assert.equal(health.status, 200); assert.equal(health.data.auth_configured, false);
  assert.equal((await s.call('POST', '/v1/auth/wechat', { code: 'developer-code' })).status, 503);
  assert.equal((await s.call('GET', '/v1/publish')).status, 404);
  assert.equal(s.writes(), 0);
});
test('health identifies missing or invalid settings without returning configuration values', async () => {
  const cases = [
    ['WX_APP_ID', undefined, 'missing'], ['WX_APP_ID', 'wrong-app-id', 'invalid'],
    ['WX_APP_SECRET', undefined, 'missing'], ['WX_APP_SECRET', '  ', 'missing'],
    ['QBANK_SESSION_SECRET', undefined, 'missing'], ['QBANK_SESSION_SECRET', 'a'.repeat(63), 'invalid'],
    ['QBANK_SESSION_SECRET', 'A'.repeat(64), 'invalid'], ['QBANK_SESSION_SECRET', 'a'.repeat(64) + '\n', 'invalid'],
    ['QBANK_BANKS', undefined, 'empty'], ['QBANK_BANKS', '[]', 'empty'],
  ];
  const ready = await setup().call('GET', '/health');
  assert.equal(ready.data.auth_configured, true);
  assert.deepEqual(ready.data.auth_checks, {
    WX_APP_ID: 'ok', WX_APP_SECRET: 'ok', QBANK_SESSION_SECRET: 'ok', QBANK_BANKS: 'ok',
  });
  for (const [key, value, expected] of cases) {
    const s = setup(); s.env.QBANK_DEVELOPERS = '{}';
    if (value === undefined) delete s.env[key]; else s.env[key] = value;
    const health = await s.call('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.auth_configured, false);
    assert.equal(health.data.auth_checks[key], expected);
    assert.equal((await s.call('POST', '/v1/auth/wechat', { code: 'developer-code' })).status, 503);
    const serialized = JSON.stringify(health);
    for (const privateValue of [envConfig().WX_APP_ID, envConfig().WX_APP_SECRET,
      envConfig().QBANK_SESSION_SECRET, packet.bank_id, packet.name, developer]) {
      assert.ok(!serialized.includes(privateValue));
    }
    assert.equal(s.writes(), 0);
  }
});
test('only trusted WeChat identity matched against bank allowlist gets a session', async () => {
  const s = setup();
  const anonymous = await s.call('POST', '/v1/auth/wechat', { code: 'unknown-code' });
  assert.equal(anonymous.status, 403); assert.equal(anonymous.data.error.details.openid, guest);
  assert.equal(anonymous.data.access_token, undefined);
  assert.equal((await s.call('POST', '/v1/auth/wechat', { code: 'unknown-code', isDeveloper: true })).status, 400);
  const token = await s.login(); assert.ok(token);
  assert.ok(!JSON.stringify(anonymous).includes('never-return'));
  const me = await s.call('GET', '/v1/me', undefined, token);
  assert.deepEqual(me.data.permissions, ['upload']); assert.equal(me.data.banks.length, 1);
  assert.ok(!JSON.stringify(me).includes(s.env.WX_APP_SECRET));
});
test('authentication is required; tampered, expired, wrong app and revoked sessions are rejected', async () => {
  const s = setup(), token = await s.login();
  assert.equal((await s.call('POST', '/v1/uploads', encodeUpload(fixture))).status, 401);
  assert.equal((await s.call('GET', '/v1/me', undefined, token + 'x')).status, 401);
  assert.equal((await s.call('GET', '/v1/me', undefined, null, { headers: { authorization: token } })).status, 401);
  s.env.WX_APP_ID = 'wx1111111111111111';
  assert.equal((await s.call('GET', '/v1/me', undefined, token)).status, 401);
  s.env.WX_APP_ID = 'wx0000000000000000'; s.env.QBANK_DEVELOPERS = '{}';
  assert.equal((await s.call('GET', '/v1/me', undefined, token)).status, 403);
  s.env.QBANK_DEVELOPERS = envConfig().QBANK_DEVELOPERS; s.env.QBANK_AUTH_VERSION = '2';
  assert.equal((await s.call('GET', '/v1/me', undefined, token)).status, 401);
  s.env.QBANK_AUTH_VERSION = '1'; s.advance(LIMITS.sessionSeconds);
  assert.equal((await s.call('GET', '/v1/me', undefined, token)).status, 401);
  assert.equal(s.writes(), 0);
});
test('valid compressed delta is durable and retries including concurrent requests are idempotent', async () => {
  const s = setup(), token = await s.login(), upload = encodeUpload(fixture);
  const results = await Promise.all(Array.from({ length: 4 }, () => s.call('POST', '/v1/uploads', upload, token)));
  assert.deepEqual(results.map(r => r.status), [201, 200, 200, 200]);
  for (const result of results) assert.deepEqual(result.data.receipt, results[0].data.receipt);
  assert.equal(s.writes(), 1); assert.equal(results[0].data.receipt.status, 'pending_review');
  assert.deepEqual([...s.records.keys()], [`inbox/${packet.bank_id}/${packet.batch_id}.json`]);
  const stored = [...s.records.values()][0];
  assert.equal(stored.package.encoding, 'gzip+base64');
  assert.ok(!JSON.stringify(results).includes('submitted_by'));
  assert.ok(!JSON.stringify(stored).includes(developer));
  const conflict = await s.call('POST', '/v1/uploads', changePacket((d, q) => { q.stem += '修改'; }), token);
  assert.equal(conflict.status, 409); assert.equal(s.writes(), 1);
});
test('cross-bank, unknown bank and path tricks never write objects', async () => {
  const s = setup(), token = await s.login();
  const other = changePacket((d, q) => { d.bank_id = bank2; d.name = q.bank = '另一个题库'; });
  assert.equal((await s.call('POST', '/v1/uploads', other, token)).status, 403);
  const unknown = changePacket(d => { d.bank_id = randomUUID(); });
  assert.equal((await s.call('POST', '/v1/uploads', unknown, token)).status, 403);
  const extra = { ...encodeUpload(fixture), bucket: 'release', key: '../catalog.json' };
  assert.equal((await s.call('POST', '/v1/uploads', extra, token)).status, 422);
  assert.equal((await s.call('POST', '/v1/publish', {}, token)).status, 404);
  assert.equal(s.writes(), 0);
});
test('corruption, malformed base64, decompression bombs and wrong checksums are rejected', async () => {
  const s = setup(), token = await s.login(), good = encodeUpload(fixture);
  for (const upload of [
    { ...good, data: good.data + '$' }, { ...good, data: Buffer.from('not gzip').toString('base64') },
    { ...good, sha256: '0'.repeat(64) }, { ...good, uncompressed_size: 10 },
    { ...good, uncompressed_size: LIMITS.expandedBytes + 1 },
    { ...good, uncompressed_size: 100, data: gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1)).toString('base64') },
  ]) assert.equal((await s.call('POST', '/v1/uploads', upload, token)).status, 422);
  assert.equal(s.writes(), 0);
});
test('model version is required and photos/extra fields/approved states cannot enter intake storage', async () => {
  const s = setup(), token = await s.login();
  for (const edit of [
    (d, q) => { q.photo = 'base64-photo'; },
    (d, q) => { q.status = 'approved'; },
    (d, q) => { q.sources[0].model.version = ''; },
    (d, q) => { q.sources[0].photo = 'do not retain'; },
    (d, q) => { q.sources[0].recorded_at = 'invalid'; },
  ]) assert.equal((await s.call('POST', '/v1/uploads', changePacket(edit), token)).status, 422);
  assert.equal(s.writes(), 0);
});
test('upload switch and storage failures never report successful registration', async () => {
  const s = setup({ store: { createSubmission: async () => { throw new Error('SECRET and raw SDK trace'); } } });
  const token = await s.login(); s.env.QBANK_UPLOAD_ENABLED = 'false';
  assert.equal((await s.call('POST', '/v1/uploads', encodeUpload(fixture), token)).status, 503);
  s.env.QBANK_UPLOAD_ENABLED = 'true';
  const failure = await s.call('POST', '/v1/uploads', encodeUpload(fixture), token);
  assert.equal(failure.status, 502); assert.ok(!JSON.stringify(failure).includes('SECRET'));
  assert.equal(failure.data.receipt, undefined);
});
test('request limits, CORS and local login throttling work independently of client role flags', async () => {
  const s = setup();
  assert.equal((await s.call('POST', '/v1/auth/wechat', { code: 'x'.repeat(2000) })).status, 413);
  assert.equal((await s.call('OPTIONS', '/v1/uploads', undefined, null, { headers: { origin: 'https://evil.example' } })).status, 403);
  s.env.QBANK_ALLOWED_ORIGINS = '["https://localhost"]';
  const preflight = await s.call('OPTIONS', '/v1/uploads', undefined, null, { headers: { origin: 'https://localhost' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], 'https://localhost');
  for (let i = 0; i < 9; i++) await s.call('POST', '/v1/auth/wechat', { code: 'developer-code' });
  assert.equal((await s.call('POST', '/v1/auth/wechat', { code: 'developer-code' })).status, 429);
});
test('COS adapter verifies bucket versioning and uses atomic create, then reads only that batch on conflict', async () => {
  const calls = []; let exists = false;
  const record = { format: 'qbank-submission-1', sha256: 'test-record' };
  const cos = {
    getBucketVersioning: async p => { calls.push(['versioning', p]); return { VersioningConfiguration: {} }; },
    putObject: async p => { calls.push(['put', p]); if (exists) throw { statusCode: 409, code: 'FileAlreadyExists' }; exists = true; },
    getObject: async p => { calls.push(['get', p]); return { Body: Buffer.from(JSON.stringify(record)) }; },
  };
  const store = createCosStore({ env: () => ({ COS_INBOX_BUCKET: 'qbank-inbox-1324463245', COS_REGION: 'ap-guangzhou' }), clientFactory: () => cos });
  const key = `inbox/${packet.bank_id}/${packet.batch_id}.json`;
  assert.equal((await store.createSubmission(key, record)).created, true);
  assert.deepEqual((await store.createSubmission(key, record)).record, record);
  assert.equal(calls.find(([kind]) => kind === 'put')[1].Headers['x-cos-forbid-overwrite'], 'true');
  assert.ok(calls.every(([, params]) => params.Bucket === 'qbank-inbox-1324463245'));
  cos.getBucketVersioning = async () => ({ VersioningConfiguration: { Status: 'Enabled' } });
  await assert.rejects(store.createSubmission(key, record), /versioning/);
  cos.getBucketVersioning = async () => { throw new Error('AccessDenied'); };
  await assert.rejects(store.createSubmission(key, record), /AccessDenied/);
});
test('WeChat adapter sends secrets only to official API and discards session_key', async () => {
  let captured;
  const exchange = createWechatExchange(async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ openid: developer, session_key: 'private-key', unionid: 'not-needed' }));
  });
  assert.deepEqual(await exchange({ appId: 'wx-test', appSecret: 'secret', code: 'wx-code' }), { openid: developer });
  assert.equal(captured.url.origin, 'https://api.weixin.qq.com');
  assert.equal(captured.url.pathname, '/sns/jscode2session'); assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.url.searchParams.get('grant_type'), 'authorization_code');
  const badCode = createWechatExchange(async () => new Response(JSON.stringify({ errcode: 40029, errmsg: 'secret detail' })));
  await assert.rejects(badCode({}), error => error.status === 401 && !error.message.includes('secret'));
  const timeout = createWechatExchange(async () => { throw new Error('https://example.com/?secret=private'); });
  await assert.rejects(timeout({}), error => error.status === 502 && !error.message.includes('private'));
});
