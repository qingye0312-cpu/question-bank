import {createServer} from 'node:http';
// The Mini Program no longer serves or bundles question files locally.
// Development only. LAN access must be explicitly enabled with BANK_HOST.
// Expose only the cloud-only health status, never arbitrary repo paths.
const host = process.env.BANK_HOST || '127.0.0.1';
const port = 8765;
const server = createServer(async (req, res) => {
  res.on('finish', () => console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${req.method} ${req.url} ${res.statusCode}`));
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify({status: 'ok', mode: 'cloud-only', uptimeSeconds: Math.floor(process.uptime())}));
    return;
  }
  if (req.method === 'GET' && req.url === '/bank.json') {
    res.writeHead(410, {'Content-Type': 'text/plain; charset=utf-8'});
    res.end('The Mini Program uses the cloud question bank.');
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(port, host, () => console.log(`Cloud-only Mini Program server: http://${host}:${port}/health`));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { console.log(`Stopping (${signal})`); server.close(); server.closeIdleConnections(); });
}
server.on('error', error => {console.error(error.message); process.exitCode = 1;});
