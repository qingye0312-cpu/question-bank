import http from 'node:http';
import https from 'node:https';
import { createHmac } from 'node:crypto';
import { realpathSync } from 'node:fs';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { RTCPeerConnection } from 'werift';

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const HASH_LINE = /^([a-f0-9]{64})\s+(.+)$/i;
const MAX_BODY_BYTES = 96 * 1024;
const MAX_FILE_BYTES = Number(process.env.QBANK_FASTDOWNLOAD_MAX_FILE_BYTES || 1024 * 1024 * 1024);
const NEGOTIATION_TIMEOUT_MS = 30_000;
const HIGH_WATER_BYTES = 1024 * 1024;
const ACK_BYTES = 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;
const MAX_ACTIVE_PEERS = Number(process.env.QBANK_FASTDOWNLOAD_MAX_PEERS || 2);
const bindHost = process.env.QBANK_FASTDOWNLOAD_BIND_HOST || '127.0.0.1';
const port = Number(process.env.QBANK_FASTDOWNLOAD_PORT || 8090);
const caddyHost = process.env.QBANK_FASTDOWNLOAD_CADDY_HOST || 'qbank.acharrystar.top';
const caddyPort = Number(process.env.QBANK_FASTDOWNLOAD_CADDY_PORT || 8443);
const stunUrls = (process.env.QBANK_FASTDOWNLOAD_STUN_URLS || 'stun:stun.cloudflare.com:3478')
  .split(',').map(value => value.trim()).filter(Boolean);
const turnUrls = (process.env.QBANK_FASTDOWNLOAD_TURN_URLS || '')
  .split(',').map(value => value.trim()).filter(Boolean);
const turnSharedSecret = process.env.QBANK_FASTDOWNLOAD_TURN_SECRET || '';
const turnCredentialTtlSec = Number(process.env.QBANK_FASTDOWNLOAD_TURN_TTL_SECONDS || 3600);
const allowedOrigins = new Set((process.env.QBANK_FASTDOWNLOAD_ALLOWED_ORIGINS || 'https://qbank.acharrystar.top:8013')
  .split(',').map(value => value.trim()).filter(Boolean));

const artifacts = {
  macos: version => ({
    filename: `qbank-${version}-macos-arm64.dmg`,
    path: `/v1/desktop/releases/macos/${version}/qbank-${version}-macos-arm64.dmg`,
    checksumPath: `../macos/${version}/qbank-${version}-macos-arm64.dmg`,
  }),
  'windows-setup': version => ({
    filename: `qbank-${version}-windows-x64-setup.exe`,
    path: `/v1/desktop/releases/windows/${version}/qbank-${version}-windows-x64-setup.exe`,
    checksumPath: `../windows/${version}/qbank-${version}-windows-x64-setup.exe`,
  }),
  'windows-portable': version => ({
    filename: `qbank-${version}-windows-x64-portable.exe`,
    path: `/v1/desktop/releases/windows/${version}/qbank-${version}-windows-x64-portable.exe`,
    checksumPath: `../windows/${version}/qbank-${version}-windows-x64-portable.exe`,
  }),
};

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

export function createTurnIceServer(urls, secret, ttlSec, nowMs = Date.now()) {
  if (urls.length === 0 && !secret) return null;
  if (urls.length === 0 || !secret) throw new Error('TURN URL 和共享密钥必须同时配置');
  if (!Number.isSafeInteger(ttlSec) || ttlSec < 60 || ttlSec > 86_400) {
    throw new Error('TURN 凭据有效期必须是 60 到 86400 秒');
  }
  const username = `${Math.floor(nowMs / 1000) + ttlSec}:qbank`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { urls, username, credential };
}

function caddyRequest(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port: caddyPort,
      method,
      path,
      servername: caddyHost,
      checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(caddyHost, certificate),
      headers: { host: `${caddyHost}:${caddyPort}` },
      timeout: 20_000,
    }, resolve);
    req.once('timeout', () => req.destroy(new Error('本机 Caddy 请求超时')));
    req.once('error', reject);
    req.end();
  });
}

async function readCaddyText(path, limit = 1024 * 1024) {
  const response = await caddyRequest(path);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`本机 Caddy 返回 HTTP ${response.statusCode}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > limit) throw new Error('本机 Caddy 响应过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadArtifact(key) {
  const get = artifacts[key];
  if (!get) throw Object.assign(new Error('不支持的下载版本'), { status: 400 });

  let manifest;
  try { manifest = JSON.parse(await readCaddyText('/v1/desktop/latest.json', 128 * 1024)); }
  catch { throw Object.assign(new Error('暂时无法读取最新版本清单'), { status: 503 }); }
  const version = String(manifest.version || '');
  if (!RELEASE_VERSION.test(version)) throw Object.assign(new Error('最新版本清单格式无效'), { status: 503 });

  const asset = get(version);
  let sums;
  try { sums = await readCaddyText(`/v1/desktop/releases/${version}/SHA256SUMS`); }
  catch { throw Object.assign(new Error('暂时无法读取安装包校验信息'), { status: 503 }); }
  const checksum = sums.split(/\r?\n/).map(line => line.match(HASH_LINE)).find(match => match?.[2] === asset.checksumPath)?.[1];
  if (!checksum) throw Object.assign(new Error('安装包没有可信的 SHA-256 校验记录'), { status: 503 });

  let head;
  try { head = await caddyRequest(asset.path, 'HEAD'); }
  catch { throw Object.assign(new Error('暂时无法读取安装包'), { status: 503 }); }
  const size = Number(head.headers['content-length']);
  head.resume();
  if (head.statusCode !== 200 || !Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
    throw Object.assign(new Error('安装包不存在或超过直连传输大小限制'), { status: 404 });
  }
  return { ...asset, version, size, sha256: checksum.toLowerCase() };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求内容不是合法 JSON'), { status: 400 }); }
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForDrain(channel) {
  while (channel.bufferedAmount > HIGH_WATER_BYTES) {
    if (channel.readyState !== 'open') throw new Error('WebRTC 数据通道已关闭');
    await wait(10);
  }
}

async function streamAsset(channel, asset, waitForAck, assetOpener) {
  const response = await assetOpener(asset.path);
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`安装包读取失败（HTTP ${response.statusCode}）`);
  }

  let sent = 0;
  let acknowledged = 0;
  for await (const incoming of response) {
    for (let offset = 0; offset < incoming.length; offset += CHUNK_BYTES) {
      await waitForDrain(channel);
      const chunk = incoming.subarray(offset, Math.min(offset + CHUNK_BYTES, incoming.length));
      const nextSent = sent + chunk.length;
      const ack = nextSent - acknowledged >= ACK_BYTES || nextSent === asset.size
        ? waitForAck(nextSent)
        : null;
      channel.send(chunk);
      sent = nextSent;
      if (ack) {
        await ack;
        acknowledged = sent;
      }
    }
  }
  if (sent !== asset.size) throw new Error('安装包传输长度不匹配');
  await waitForDrain(channel);
  channel.send(JSON.stringify({ type: 'complete', size: sent, sha256: asset.sha256 }));
}

function makePeer(offer, asset, activePeers, assetOpener, iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  let channel;
  let started = false;
  let closed = false;
  let timer;
  const pendingAcks = new Map();
  const waitForAck = received => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAcks.delete(received);
      reject(new Error('等待浏览器写入文件超时'));
    }, 30_000);
    pendingAcks.set(received, {
      resolve: () => { clearTimeout(timeout); pendingAcks.delete(received); resolve(); },
      reject: error => { clearTimeout(timeout); pendingAcks.delete(received); reject(error); },
    });
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const pending of pendingAcks.values()) pending.reject(new Error('WebRTC 数据通道已关闭'));
    pendingAcks.clear();
    activePeers.delete(pc);
    if (channel?.readyState === 'open') channel.close();
    await pc.close().catch(() => {});
  };
  const armTimeout = ms => {
    clearTimeout(timer);
    timer = setTimeout(() => { void close(); }, ms);
    timer.unref?.();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') void close();
    if (pc.connectionState === 'connected') armTimeout(30 * 60_000);
  };
  pc.ondatachannel = event => {
    channel = event.channel;
    if (channel.label !== 'fastdownload') {
      void close();
      return;
    }
    channel.onmessage = eventMessage => {
      const text = Buffer.isBuffer(eventMessage.data) ? eventMessage.data.toString('utf8') : String(eventMessage.data);
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (message.type === 'ack' && Number.isSafeInteger(message.received)) {
        pendingAcks.get(message.received)?.resolve();
        return;
      }
      if (message.type === 'done') {
        void close();
        return;
      }
      if (message.type !== 'ready' || started) return;
      started = true;
      void streamAsset(channel, asset, waitForAck, assetOpener).catch(error => {
        if (channel.readyState === 'open') channel.send(JSON.stringify({ type: 'error', message: error.message }));
        void close();
      });
    };
    channel.onopen = () => {
      armTimeout(60_000);
      channel.send(JSON.stringify({
        type: 'metadata',
        filename: asset.filename,
        version: asset.version,
        size: asset.size,
        sha256: asset.sha256,
      }));
    };
    channel.onclose = () => { if (!started) void close(); };
  };
  activePeers.add(pc);
  armTimeout(60_000);

  return {
    pc,
    close,
    negotiate: async () => {
      await pc.setRemoteDescription(offer);
      const answer = await pc.setLocalDescription(await pc.createAnswer());
      return answer.toJSON();
    },
  };
}

export function createFastDownloadServer({
  allowedOrigins: origins = allowedOrigins,
  iceUrls = stunUrls,
  turnIceUrls = turnUrls,
  turnSecret = turnSharedSecret,
  turnTtlSec = turnCredentialTtlSec,
  assetLoader = loadArtifact,
  assetOpener = path => caddyRequest(path),
} = {}) {
  const activePeers = new Set();
  const createIceServers = () => [
    ...iceUrls.map(urls => ({ urls })),
    createTurnIceServer(turnIceUrls, turnSecret, turnTtlSec),
  ].filter(Boolean);
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, activePeers: activePeers.size });
    if (req.method === 'GET' && pathname === '/fastdowmload/api/config') {
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) return json(res, 403, { error: '来源不受支持' });
      return json(res, 200, { iceServers: createIceServers() });
    }
    if (req.method !== 'POST' || pathname !== '/fastdowmload/api/offer') return json(res, 404, { error: 'Not found' });
    if (!origins.has(req.headers.origin)) return json(res, 403, { error: '来源不受支持' });
    if (activePeers.size >= MAX_ACTIVE_PEERS) return json(res, 503, { error: '当前直连人数较多，请稍后重试或使用普通下载' });

    let peer;
    try {
      const body = await readJson(req);
      if (body?.offer?.type !== 'offer' || typeof body.offer.sdp !== 'string' || body.offer.sdp.length > 80_000) {
        throw Object.assign(new Error('WebRTC offer 无效'), { status: 400 });
      }
      const asset = await assetLoader(body.artifact);
      peer = makePeer(body.offer, asset, activePeers, assetOpener, createIceServers());
      let timer;
      const answer = await Promise.race([
        peer.negotiate(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('ICE 候选协商超时'), { status: 504 })), NEGOTIATION_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      json(res, 200, { answer });
    } catch (error) {
      if (peer) await peer.close();
      json(res, error.status || 500, { error: error.status ? error.message : '暂时无法建立直连，请使用普通下载' });
    }
  });

  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  server.on('close', () => { for (const pc of activePeers) void pc.close(); });
  return { server, activePeers };
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QBANK_FASTDOWNLOAD_PORT 无效');
  const { server } = createFastDownloadServer();
  server.listen(port, bindHost, () => console.log(`qbank-fastdownload listening on ${bindHost}:${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
