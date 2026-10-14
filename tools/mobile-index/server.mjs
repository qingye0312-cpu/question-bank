import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

// Development only: bind loopback and expose only the generated bank, not the repo.
const directory = new URL('../../miniprogram/miniprogram/data/', import.meta.url);
const server = createServer(async (req, res) => {
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
server.listen(8765, '127.0.0.1', () => console.log('Local bank server: http://127.0.0.1:8765/bank.json'));
server.on('error', error => {console.error(error.message); process.exitCode = 1;});
