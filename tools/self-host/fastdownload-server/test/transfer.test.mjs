import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { RTCPeerConnection } from 'werift';
import { createFastDownloadServer, createTurnIceServer } from '../server.mjs';

test('TURN credentials use the shared secret and expire after the configured lifetime', () => {
  const nowMs = 1_700_000_000_000;
  const secret = 'test-secret';
  const turn = createTurnIceServer(['turn:turn.example.test:3478?transport=udp'], secret, 600, nowMs);
  const expectedUsername = '1700000600:qbank';
  assert.equal(turn.username, expectedUsername);
  assert.equal(turn.credential, createHmac('sha1', secret).update(expectedUsername).digest('base64'));
  assert.deepEqual(turn.urls, ['turn:turn.example.test:3478?transport=udp']);
});

test('the offer endpoint streams a package over a peer DataChannel with bounded acknowledgements', async t => {
  const content = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
  content.write('qbank-fastdownload', 0, 'utf8');
  const digest = createHash('sha256').update(content).digest('hex');
  const asset = { filename: '题库-test.bin', version: '1.2.3', size: content.length, sha256: digest, path: '/fixture' };
  const serverInstance = createFastDownloadServer({
    allowedOrigins: new Set(['http://127.0.0.1']),
    iceUrls: [],
    assetLoader: async key => {
      assert.equal(key, 'macos');
      return asset;
    },
    assetOpener: async () => {
      const stream = (await import('node:stream')).Readable.from([content]);
      stream.statusCode = 200;
      return stream;
    },
  });
  serverInstance.server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    serverInstance.server.once('listening', resolve);
    serverInstance.server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => serverInstance.server.close(resolve));
  });

  const client = new RTCPeerConnection({ iceServers: [] });
  t.after(async () => { await client.close(); });
  const channel = client.createDataChannel('fastdownload', { ordered: true });
  const receivedChunks = [];
  let received = 0;
  let acknowledged = 0;
  let metadata;
  const transfer = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('DataChannel transfer timed out')), 15_000);
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string') {
        const chunk = Buffer.from(data);
        receivedChunks.push(chunk);
        received += chunk.length;
        if (received - acknowledged >= 1024 * 1024 || received === metadata.size) {
          acknowledged = received;
          channel.send(JSON.stringify({ type: 'ack', received }));
        }
        return;
      }
      const message = JSON.parse(data);
      if (message.type === 'metadata') {
        metadata = message;
        assert.equal(message.filename, asset.filename);
        channel.send(JSON.stringify({ type: 'ready' }));
      } else if (message.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(message.message));
      } else if (message.type === 'complete') {
        clearTimeout(timeout);
        channel.send(JSON.stringify({ type: 'done' }));
        resolve(message);
      }
    };
  });
  void transfer.catch(() => {});

  await client.setLocalDescription(await client.createOffer());
  const address = serverInstance.server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/fastdowmload/api/offer`, {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' },
    body: JSON.stringify({ artifact: 'macos', offer: client.localDescription }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.answer?.type, 'answer');
  assert.equal(typeof body.answer?.sdp, 'string');
  await client.setRemoteDescription(body.answer);

  const completion = await transfer;
  const result = Buffer.concat(receivedChunks);
  assert.equal(completion.size, content.length);
  assert.equal(completion.sha256, digest);
  assert.deepEqual(result, content);
});
