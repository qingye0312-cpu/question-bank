'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { gunzipSync, gzipSync } = require('node:zlib');

const VERSION = '0.2.7';
const LIMITS = Object.freeze({ requestBytes: 768 * 1024, compressedBytes: 512 * 1024,
  expandedBytes: 4 * 1024 * 1024, questions: 100, sessionSeconds: 900 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPENID = /^[A-Za-z0-9_-]{10,128}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class HttpError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
function fail(status, code, message, details) { throw new HttpError(status, code, message, details); }
function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function envJSON(env, name, fallback) {
  try { return JSON.parse(env[name] || fallback); }
  catch { fail(503, 'CONFIG_INVALID', `服务端 ${name} 配置无效`); }
}
function loadConfig(env) {
  const banks = envJSON(env, 'QBANK_BANKS', '[]');
  if (!Array.isArray(banks) || banks.length > 100 || banks.some(b => !exact(b, ['bank_id', 'name'])
    || !UUID.test(b.bank_id) || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100)
    || new Set(banks.map(b => b.bank_id)).size !== banks.length) fail(503, 'CONFIG_INVALID', '题库目录配置无效');
  const ids = new Set(banks.map(b => b.bank_id));
  const developers = envJSON(env, 'QBANK_DEVELOPERS', '{}');
  if (!object(developers) || Object.keys(developers).length > 100 || Object.entries(developers).some(([id, allowed]) =>
    !OPENID.test(id) || !Array.isArray(allowed) || allowed.some(bank => !ids.has(bank))))
    fail(503, 'CONFIG_INVALID', '开发者允许名单配置无效');
  const origins = envJSON(env, 'QBANK_ALLOWED_ORIGINS', '[]');
  if (!Array.isArray(origins) || origins.some(o => typeof o !== 'string'
    || !/^(https?:\/\/[^/\s]+|tauri:\/\/localhost)$/.test(o))) fail(503, 'CONFIG_INVALID', '跨域配置无效');
  return { banks, developers, origins, appId: env.WX_APP_ID || '', appSecret: env.WX_APP_SECRET || '',
    sessionSecret: env.QBANK_SESSION_SECRET || '', authVersion: env.QBANK_AUTH_VERSION || '1',
    uploadsEnabled: env.QBANK_UPLOAD_ENABLED === 'true' };
}
function authChecks(config) {
  // Public diagnostics contain only fixed status labels, never environment values.
  return {
    WX_APP_ID: !config.appId ? 'missing' : /^wx[0-9a-f]{16}$/.test(config.appId) ? 'ok' : 'invalid',
    WX_APP_SECRET: config.appSecret.trim() ? 'ok' : 'missing',
    QBANK_SESSION_SECRET: !config.sessionSecret ? 'missing' : HASH.test(config.sessionSecret) ? 'ok' : 'invalid',
    QBANK_BANKS: config.banks.length > 0 ? 'ok' : 'empty',
  };
}
function authConfigured(config) {
  return Object.values(authChecks(config)).every(status => status === 'ok');
}
function requireAuthConfig(config) {
  if (!authConfigured(config)) fail(503, 'AUTH_NOT_CONFIGURED', '登录服务尚未配置完成');
}
function sign(payload, config) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(config.sessionSecret, 'hex'))
    .update(`qbank-session-v1.${encoded}`).digest('base64url');
  return `v1.${encoded}.${signature}`;
}
function verify(token, config, now) {
  if (typeof token !== 'string' || token.length > 2048) fail(401, 'LOGIN_REQUIRED', '请先进行开发者登录');
  const parts = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) fail(401, 'SESSION_INVALID', '登录已失效，请重新登录');
  const expected = createHmac('sha256', Buffer.from(config.sessionSecret, 'hex'))
    .update(`qbank-session-v1.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail(401, 'SESSION_INVALID', '登录已失效，请重新登录');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { fail(401, 'SESSION_INVALID', '登录已失效，请重新登录'); }
  if (!object(payload) || !OPENID.test(payload.sub) || payload.aud !== 'qbank-upload-v1'
    || payload.app_id !== config.appId || payload.auth_version !== config.authVersion
    || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
    || payload.exp <= now || payload.iat > now + 30 || payload.exp - payload.iat !== LIMITS.sessionSeconds)
    fail(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
  // Permissions are re-read on every request. The token never carries trusted roles.
  const banks = Object.hasOwn(config.developers, payload.sub) ? config.developers[payload.sub] : [];
  if (!banks.length) fail(403, 'DEVELOPER_NOT_ALLOWED', '此微信用户尚未获得上传授权');
  return { openid: payload.sub, banks };
}
function strictBase64(text, maxBytes) {
  if (typeof text !== 'string' || !text.length || text.length > Math.ceil(maxBytes / 3) * 4
    || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text))
    fail(422, 'PACKAGE_INVALID', 'Base64 内容无效或超过大小限制');
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== text) fail(422, 'PACKAGE_INVALID', 'Base64 内容无效');
  return bytes;
}
function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(422, 'PACKAGE_INVALID', '题库必须使用 UTF-8 编码'); }
}
function jsonBody(event, maxBytes) {
  if (typeof event.body !== 'string') fail(400, 'JSON_REQUIRED', '请求必须包含 JSON 文本');
  if (Buffer.byteLength(event.body) > maxBytes * (event.isBase64Encoded === true ? 1.34 : 1))
    fail(413, 'REQUEST_TOO_LARGE', '请求过大，请拆分录入批次');
  const text = event.isBase64Encoded === true ? utf8(strictBase64(event.body, maxBytes)) : event.body;
  if (Buffer.byteLength(text) > maxBytes) fail(413, 'REQUEST_TOO_LARGE', '请求过大，请拆分录入批次');
  try { return JSON.parse(text); } catch { fail(400, 'JSON_INVALID', '请求不是有效 JSON'); }
}
function validDate(value) { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }

function decodeUpload(envelope, parseDelta, parseModelReply) {
  if (!exact(envelope, ['format', 'encoding', 'uncompressed_size', 'sha256', 'data'])
    || envelope.format !== 'qbank-upload-1' || envelope.encoding !== 'gzip+base64'
    || !HASH.test(envelope.sha256) || !Number.isSafeInteger(envelope.uncompressed_size)
    || envelope.uncompressed_size < 1 || envelope.uncompressed_size > LIMITS.expandedBytes)
    fail(422, 'PACKAGE_INVALID', '请使用 gzip + Base64 增量包格式');
  const compressed = strictBase64(envelope.data, LIMITS.compressedBytes);
  let raw;
  try { raw = gunzipSync(compressed, { maxOutputLength: Math.min(envelope.uncompressed_size, LIMITS.expandedBytes) }); }
  catch { fail(422, 'PACKAGE_INVALID', '压缩包损坏或解压后超过大小限制'); }
  if (raw.length !== envelope.uncompressed_size || sha256(raw) !== envelope.sha256)
    fail(422, 'PACKAGE_INVALID', '增量包大小或摘要校验失败');
  let parsed;
  try { parsed = parseDelta(utf8(raw)); }
  catch (error) { if (error instanceof HttpError) throw error; fail(422, 'PACKAGE_INVALID', '标准增量包内容校验失败'); }
  const { delta, questions } = parsed;
  if (!UUID.test(delta.bank_id) || !UUID.test(delta.batch_id) || questions.length > LIMITS.questions
    || !validDate(delta.created_at)) fail(422, 'PACKAGE_INVALID', '题库身份、批次日期或题数无效');
  const fields = ['schema_version', 'question_id', 'base_revision', 'type', 'stem', 'options', 'answer', 'bank',
    'external_id', 'chapter', 'tags', 'explanation', 'status', 'difficulty', 'applicable_version', 'source_note', 'issues', 'sources', 'attachments'];
  for (const q of questions) {
    if (!exact(q, fields) || q.status !== 'unreviewed' || q.base_revision !== 1 || q.bank !== delta.name
      || q.options.some(o => !exact(o, ['key', 'content', 'option_id']))
      || new Set(q.options.map(o => o.option_id)).size !== q.options.length
      || q.sources.length !== 1) fail(422, 'QUESTION_INVALID', '只接受保留模型来源的新题，不接受额外附件或已审核状态');
    const source = q.sources[0];
    if (!exact(source, ['kind', 'model', 'answer_origin', 'warnings', 'recorded_at'])
      || source.kind !== 'model_reply' || !validDate(source.recorded_at))
      fail(422, 'QUESTION_INVALID', '模型名称、版本和录入时间记录不完整');
    try { parseModelReply(JSON.stringify({ format: 'qbank-photo-question-1', type: q.type, stem: q.stem,
      options: q.options.map(({ key, content }) => ({ key, content })), answer: q.answer, explanation: q.explanation,
      model: source.model, answer_origin: source.answer_origin, warnings: source.warnings })); }
    catch { fail(422, 'QUESTION_INVALID', '题目或模型来源记录校验失败'); }
  }
  // Normalize compression server-side: the stored package never contains extra gzip members/trailing data.
  const canonical = { ...envelope, data: gzipSync(raw).toString('base64') };
  return { delta, envelope: canonical };
}
function receipt(record) {
  return { submission_id: record.submission_id, bank_id: record.bank_id, batch_id: record.batch_id,
    sha256: record.sha256, payload_sha256: record.payload_sha256, question_count: record.question_count,
    status: record.status, accepted_at: record.accepted_at };
}

function createHandler({ env = () => process.env, store, exchangeCode, parseDelta, parseModelReply, clock = Date.now }) {
  const rate = new Map();
  function throttle(key, maximum) {
    const minute = Math.floor(clock() / 60000);
    for (const [k, v] of rate) if (v.minute !== minute) rate.delete(k);
    if (!rate.has(key) && rate.size >= 1000) fail(429, 'RATE_LIMITED', '请求较多，请稍后重试');
    const count = (rate.get(key)?.count || 0) + 1;
    rate.set(key, { minute, count });
    if (count > maximum) fail(429, 'RATE_LIMITED', '请求较多，请稍后重试');
  }
  return async function mainHandler(event) {
    const responseHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' };
    const respond = (statusCode, value) => ({ statusCode, headers: responseHeaders, body: JSON.stringify(value) });
    try {
      const config = loadConfig(env());
      const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      if (headers.origin) {
        if (!config.origins.includes(headers.origin)) fail(403, 'ORIGIN_DENIED', '此来源未获允许');
        responseHeaders['access-control-allow-origin'] = headers.origin;
        responseHeaders.vary = 'Origin';
      }
      const method = event.httpMethod, path = event.path;
      if (method === 'OPTIONS') {
        responseHeaders['access-control-allow-methods'] = 'GET, POST, OPTIONS';
        responseHeaders['access-control-allow-headers'] = 'content-type, authorization';
        return respond(204, null);
      }
      if (method === 'GET' && path === '/health') return respond(200, {
        service: 'qbank-auth', version: VERSION, auth_configured: authConfigured(config),
        auth_checks: authChecks(config),
        uploads_enabled: config.uploadsEnabled, limits: LIMITS,
      });
      if (!['POST /v1/auth/wechat', 'GET /v1/me', 'POST /v1/uploads'].includes(`${method} ${path}`))
        fail(404, 'NOT_FOUND', '接口不存在');
      requireAuthConfig(config);
      const now = Math.floor(clock() / 1000);
      if (method === 'POST' && headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
        fail(415, 'JSON_REQUIRED', '请使用 application/json');
      if (path === '/v1/auth/wechat') {
        throttle('login:all', 100);
        throttle(`login:${String(headers['x-scf-remote-addr'] || 'unknown').slice(0, 100)}`, 10);
        const body = jsonBody(event, 1024);
        if (!exact(body, ['code']) || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(body.code))
          fail(400, 'CODE_REQUIRED', '请提供 wx.login 返回的临时 code');
        let identity;
        try { identity = await exchangeCode({ appId: config.appId, appSecret: config.appSecret, code: body.code }); }
        catch (error) { if (error instanceof HttpError) throw error; fail(502, 'WECHAT_UNAVAILABLE', '微信登录校验暂不可用，请重试'); }
        if (!identity || !OPENID.test(identity.openid)) fail(401, 'WECHAT_LOGIN_FAILED', '微信登录凭证无效，请重新登录');
        const banks = Object.hasOwn(config.developers, identity.openid) ? config.developers[identity.openid] : [];
        if (!banks.length) fail(403, 'DEVELOPER_NOT_ALLOWED', '此微信用户尚未获得上传授权', { openid: identity.openid });
        return respond(200, { access_token: sign({ sub: identity.openid, aud: 'qbank-upload-v1',
          app_id: config.appId, auth_version: config.authVersion, iat: now, exp: now + LIMITS.sessionSeconds }, config),
        expires_in: LIMITS.sessionSeconds, openid: identity.openid, banks: config.banks.filter(b => banks.includes(b.bank_id)) });
      }
      const auth = verify(typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
        ? headers.authorization.slice(7) : null, config, now);
      if (path === '/v1/me') return respond(200, { openid: auth.openid, banks: config.banks.filter(b => auth.banks.includes(b.bank_id)),
        permissions: ['upload'], uploads_enabled: config.uploadsEnabled });
      if (!config.uploadsEnabled) fail(503, 'UPLOAD_DISABLED', '上传服务尚未启用，本地题目仍然保留');
      throttle(`upload:${auth.openid}`, 20);
      const { delta, envelope } = decodeUpload(jsonBody(event, LIMITS.requestBytes), parseDelta, parseModelReply);
      if (!auth.banks.includes(delta.bank_id)) fail(403, 'BANK_FORBIDDEN', '没有此题库的上传权限');
      if (config.banks.find(b => b.bank_id === delta.bank_id)?.name !== delta.name)
        fail(422, 'BANK_NAME_MISMATCH', '题库名称与云端目录不一致，请先同步题库信息');
      const key = `inbox/${delta.bank_id}/${delta.batch_id}.json`;
      const record = { format: 'qbank-submission-1', submission_id: sha256(`${delta.bank_id}/${delta.batch_id}`),
        bank_id: delta.bank_id, batch_id: delta.batch_id, sha256: envelope.sha256, payload_sha256: delta.sha256,
        question_count: delta.question_count, status: 'pending_review', accepted_at: new Date(clock()).toISOString(),
        submitted_by: sha256(`${config.appId}\0${auth.openid}`), package: envelope };
      let accepted;
      try { accepted = await store.createSubmission(key, record); }
      catch { fail(502, 'STORAGE_UNAVAILABLE', '云端保存未确认，请保留本地批次并重试'); }
      if (!accepted || accepted.record?.format !== 'qbank-submission-1')
        fail(502, 'STORAGE_UNAVAILABLE', '云端记录无效，请联系维护者');
      if (accepted.record.sha256 !== record.sha256 || accepted.record.bank_id !== delta.bank_id || accepted.record.batch_id !== delta.batch_id)
        fail(409, 'BATCH_CONFLICT', '此批次已提交不同内容，请使用新批次提交修改');
      return respond(accepted.created ? 201 : 200, { receipt: receipt(accepted.record), duplicate: !accepted.created });
    } catch (error) {
      if (error instanceof HttpError) return respond(error.status, { error: { code: error.code, message: error.message,
        ...(error.details ? { details: error.details } : {}) } });
      // Never echo exception strings, request bodies, login codes, tokens or SDK credentials.
      return respond(500, { error: { code: 'INTERNAL_ERROR', message: '服务暂不可用，请保留本地数据后重试' } });
    }
  };
}

module.exports = { createHandler, loadConfig, decodeUpload, LIMITS, VERSION, HttpError, sha256 };
