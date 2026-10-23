'use strict';

// Filesystem-backed replacement for the two COS prefixes used by qbank-auth.
// Every state and submission is immutable: creation uses O_EXCL and retries
// read the existing object instead of overwriting it.
const fs = require('node:fs/promises');
const path = require('node:path');
const { packText, unpackText, FORMAT } = require('./codec.cjs');
const { LIMITS } = require('./common.cjs');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const REVISION_FILE = /^[0-9]{12}\.json$/;

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid ${label}`);
}

function assertRoot(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new Error('Invalid storage root');
  return path.resolve(root);
}

async function readPacked(file, maxBytes) {
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) throw new Error('Stored object exceeds limit');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Stored object is not JSON'); }
  const text = value?.format === FORMAT ? unpackText(value) : JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Stored object exceeds limit');
  try { return JSON.parse(text); } catch { throw new Error('Stored object payload is not JSON'); }
}

async function writePackedExclusive(file, value) {
  const text = JSON.stringify(value);
  const packed = JSON.stringify(packText(text));
  await fs.writeFile(file, packed, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function createFileStore({ root = process.env.QBANK_STORAGE_ROOT || '/var/lib/qbank-auth' } = {}) {
  const base = assertRoot(root);
  const states = path.join(base, 'states');
  const inbox = path.join(base, 'inbox');

  async function readStateFile(file, bankId, revision) {
    const state = await readPacked(file, LIMITS.expandedBytes);
    const expected = String(999999999999 - state.revision).padStart(12, '0') + '.json';
    if (state?.format !== 'qbank-state-1' || state.bank_id !== bankId
      || !Number.isSafeInteger(state.revision) || state.revision < 1 || state.revision !== revision || path.basename(file) !== expected)
      throw new Error('Invalid state identity');
    return state;
  }

  async function readStateAt(bankId, revision) {
    assertUuid(bankId, 'bank id');
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999999999998) return null;
    const file = path.join(states, bankId, String(999999999999 - revision).padStart(12, '0') + '.json');
    try { return await readStateFile(file, bankId, revision); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function listStates(bankId) {
    assertUuid(bankId, 'bank id');
    const directory = path.join(states, bankId);
    let names;
    try { names = await fs.readdir(directory); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const candidates = names.filter(name => REVISION_FILE.test(name)).sort();
    if (candidates.length > 256) throw new Error('Too many state revisions');
    const result = [];
    for (const name of candidates) {
      const revision = 999999999999 - Number(name.slice(0, 12));
      result.push(await readStateFile(path.join(directory, name), bankId, revision));
    }
    return result.sort((a, b) => b.revision - a.revision);
  }

  async function readState(bankId) { return (await listStates(bankId))[0] || null; }

  async function createState(state) {
    assertUuid(state?.bank_id, 'bank id');
    if (!Number.isSafeInteger(state.revision) || state.revision < 1 || state.revision > 999999999998)
      throw new Error('Invalid state revision');
    const directory = path.join(states, state.bank_id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = String(999999999999 - state.revision).padStart(12, '0') + '.json';
    try {
      await writePackedExclusive(path.join(directory, name), state);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }

  async function createSubmission(key, record) {
    const match = /^inbox\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.json$/.exec(key || '');
    if (!match) throw new Error('Invalid submission key');
    const [bankId, batchId] = match.slice(1);
    assertUuid(bankId, 'bank id'); assertUuid(batchId, 'batch id');
    const directory = path.join(inbox, bankId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${batchId}.json`);
    try {
      await writePackedExclusive(file, record);
      return { created: true, record };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const saved = await readPacked(file, 2 * LIMITS.requestBytes + 4096);
      return { created: false, record: saved };
    }
  }

  return { root: base, readState, readStateAt, listStates, createState, createSubmission };
}

module.exports = { createFileStore };
