import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

// Development only. LAN access must be explicitly enabled with BANK_HOST.
// Expose only the generated bank and health status, never arbitrary repo paths.
const host = process.env.BANK_HOST || '127.0.0.1';
const port = 8765;
const directory = new URL('../../miniprogram/miniprogram/data/', import.meta.url);
const server = createServer(async (req, res) => {
  res.on('finish', () => console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} ${res.statusCode}`));
  if (req.method === 'GET' && req.url === '/health') {
    try {
      await Promise.all(['manifest.json', 'questions.json', 'index.json']
        .map(name => readFile(new URL(name, directory))));
      res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify({status: 'ok', uptimeSeconds: Math.floor(process.uptime())}));
    } catch { res.writeHead(503); res.end('Bank files unavailable'); }
    return;
  }
  if (req.method !== 'GET' || req.url !== '/bank.json') {
    res.writeHead(404); res.end('Not found'); return;
  }
  try {
    const files = await Promise.all(['manifest.json', 'questions.json', 'index.json']
      .map(name => readFile(new URL(name, directory), 'utf8')));
    const body = JSON.stringify(files);
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store'});
    res.end(body);
  } catch {
    res.writeHead(503); res.end('Run pnpm prepare:miniprogram first');
  }
});
server.listen(port, host, () => console.log(`Development bank server: http://${host}:${port}/bank.json (health: /health)`));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { console.log(`Stopping (${signal})`); server.close(); server.closeIdleConnections(); });
}
server.on('error', error => {console.error(error.message); process.exitCode = 1;});
