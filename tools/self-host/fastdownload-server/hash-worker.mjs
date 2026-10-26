import { sha256 } from '@noble/hashes/sha2.js';

let hash = sha256.create();

self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'chunk') {
    hash.update(new Uint8Array(message.bytes));
    return;
  }
  if (message?.type === 'finish') {
    const digest = hash.digest();
    self.postMessage({ type: 'digest', hex: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') });
    hash = sha256.create();
    return;
  }
  if (message?.type === 'ack') {
    self.postMessage({ type: 'ack', received: message.received });
    return;
  }
  if (message?.type === 'reset') hash = sha256.create();
});
