import https from 'node:https';

// A read-only probe. Test both TLS versions with normal certificate/hostname
// verification; a successful browser request alone does not cover TLS 1.2.
const target = new URL(process.argv[2] || 'https://qbank.creart.top:8013');
if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('Provide an HTTPS origin without credentials, path, query or fragment');
}

async function probe(version) {
  return new Promise(resolve => {
    const start = Date.now();
    let finished = false, remoteAddress;
    const request = https.get(new URL('/health', target), {
      minVersion: version, maxVersion: version, rejectUnauthorized: true, agent: false,
    });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error('Request timed out'), {code: 'ETIMEDOUT'})), 10000);
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({tls: version, remoteAddress, elapsedMs: Date.now() - start, ...result});
    }
    request.on('socket', socket => socket.on('connect', () => {remoteAddress = socket.remoteAddress;}));
    request.on('response', response => {
      const protocol = response.socket.getProtocol(), authorized = response.socket.authorized;
      let body = '', bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) request.destroy(Object.assign(new Error('Health response too large'), {code: 'RESPONSE_TOO_LARGE'}));
        else body += chunk.toString('utf8');
      });
      response.on('end', () => {
        let service;
        try {service = JSON.parse(body).service;} catch { /* Report an invalid health response as a failure. */ }
        finish({ok: response.statusCode === 200 && authorized && service === 'qbank-auth', status: response.statusCode, protocol, authorized});
      });
      response.on('error', error => finish({ok: false, error: error.code || 'RESPONSE_ERROR'}));
    });
    request.on('error', error => finish({ok: false, error: error.code || 'REQUEST_ERROR'}));
  });
}

const results = await Promise.all(['TLSv1.2', 'TLSv1.3'].map(probe));
console.log(JSON.stringify({checkedAt: new Date().toISOString(), origin: target.origin, results}, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
