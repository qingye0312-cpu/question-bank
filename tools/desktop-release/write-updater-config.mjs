import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node write-updater-config.mjs <output-path>');

const endpoint = process.env.QBANK_UPDATER_ENDPOINT || '';
const publicKey = (process.env.QBANK_UPDATER_PUBLIC_KEY || '').trim();
if (!endpoint || new URL(endpoint).protocol !== 'https:') {
  throw new Error('QBANK_UPDATER_ENDPOINT must be an HTTPS URL.');
}
if (!publicKey || !Buffer.from(publicKey, 'base64').toString('utf8').startsWith('untrusted comment:')) {
  throw new Error('QBANK_UPDATER_PUBLIC_KEY must contain the existing Tauri public key.');
}

const output = path.resolve(root, destination);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify({ plugins: { updater: { pubkey: publicKey, endpoints: [endpoint] } } }, null, 2)}\n`, {
  mode: 0o600,
});
