'use strict';

// Small Node HTTP host for the same qbank-auth handler used by Tencent SCF.
// It deliberately has no framework or third-party runtime dependency.
const http = require('node:http');
const fs = require('node:fs');
const { createHandler } = require('./service.cjs');
const { createFileStore } = require('./fs-store.cjs');
const { createWechatExchange, createWechatPhoneExchange } = require('./adapters.cjs');
const { LIMITS } = require('./common.cjs');
const { parseDelta, validateStandardQuestion, parseModelReply } = require('./intake.cjs');

function loadEnvFile(file) {
  if (!file) return {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > Math.ceil(LIMITS.requestBytes * 1.34)) { reject(new Error('request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createLocalServer({ env = process.env } = {}) {
  const fileEnv = loadEnvFile(env.QBANK_ENV_FILE);
  const settings = { ...fileEnv, ...env };
  const store = createFileStore({ root: settings.QBANK_STORAGE_ROOT || '/var/lib/qbank-auth' });
  const handler = createHandler({
    env: () => settings,
    store,
    exchangeCode: createWechatExchange(),
    exchangePhone: createWechatPhoneExchange(),
    parseDelta,
    validateStandardQuestion,
    parseModelReply,
  });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await bodyOf(req);
      const event = { httpMethod: req.method, path: url.pathname, headers: req.headers, body, isBase64Encoded: false };
      const response = await handler(event);
      res.statusCode = response.statusCode;
      for (const [key, value] of Object.entries(response.headers || {})) res.setHeader(key, value);
      res.end(response.body || '');
    } catch {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '服务暂不可用，请保留本地数据后重试' } }));
    }
  });
  return { server, store, settings };
}

if (require.main === module) {
  const { server, settings, store } = createLocalServer();
  const host = settings.QBANK_BIND_HOST || '127.0.0.1';
  const port = Number(settings.QBANK_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QBANK_PORT 无效');
  server.listen(port, host, () => console.log(`qbank-auth listening on ${host}:${port}; storage=${store.root}`));
  const stop = signal => server.close(() => { console.log(`qbank-auth stopped (${signal})`); process.exit(0); });
  process.once('SIGTERM', () => stop('SIGTERM')); process.once('SIGINT', () => stop('SIGINT'));
}

module.exports = { createLocalServer, loadEnvFile };
