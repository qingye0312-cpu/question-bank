'use strict';

// Filesystem-backed durable store for the self-hosted qbank service.
// Publish complete, flushed files with a no-replace link. Retries read the
// existing object; readers never observe a partially written revision.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const { packText, unpackText } = require('./codec.cjs');
const { LIMITS } = require('./common.cjs');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const REVISION_FILE = /^[0-9]{12}\.json$/;
const ARCHIVED_REVISION_FILE = /^([0-9]{12})-archived\.json$/;

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`Invalid ${label}`);
}

function assertRoot(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new Error('Invalid storage root');
  return path.resolve(root);
}

async function readPacked(file, maxBytes) {
  const bytes = await fs.readFile(file);
  if (bytes.length > Math.ceil((maxBytes + 65536) / 3) * 4 + 512) throw new Error('Stored object exceeds limit');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Stored object is not JSON'); }
  const text = unpackText(value);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Stored object exceeds limit');
  try { return JSON.parse(text); } catch { throw new Error('Stored object payload is not JSON'); }
}

async function writePackedExclusive(file, value) {
  const text = JSON.stringify(value);
  const packed = JSON.stringify(packText(text));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(packed, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.link(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, {force:true});
  }
}

async function writePackedAtomic(file, value) {
  const text = JSON.stringify(value);
  const packed = JSON.stringify(packText(text));
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(packed, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, {force:true});
  }
}

function createFileStore({ root = process.env.QBANK_STORAGE_ROOT || '/var/lib/qbank-auth' } = {}) {
  const base = assertRoot(root);
  const states = path.join(base, 'states');
  const archivedStates = path.join(base, 'archive', 'states');
  const inbox = path.join(base, 'inbox');
  const operations = path.join(base, 'operations');

  const revisionName = revision => String(999999999999 - revision).padStart(12, '0') + '.json';
  const archivedRevisionName = revision => revisionName(revision).replace(/\.json$/, '-archived.json');

  async function readStateFile(file, bankId, revision, stored = undefined) {
    const state = stored || await readPacked(file, LIMITS.expandedBytes);
    if (!state || typeof state !== 'object') throw new Error('Invalid state identity');
    const expected = revisionName(state.revision);
    const archivedExpected = expected.replace(/\.json$/, '-archived.json');
    if (state?.format !== 'qbank-state-1' || state.bank_id !== bankId
      || !Number.isSafeInteger(state.revision) || state.revision < 1 || state.revision !== revision
      || ![expected, archivedExpected].includes(path.basename(file)))
      throw new Error('Invalid state identity');
    return state;
  }

  async function readStateAt(bankId, revision) {
    assertUuid(bankId, 'bank id');
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999999999998) return null;
    const name = revisionName(revision);
    for (const [directory, filename] of [[path.join(states, bankId), name], [path.join(archivedStates, bankId), archivedRevisionName(revision)]]) {
      const file = path.join(directory, filename);
      let stored;
      try { stored = await readPacked(file, LIMITS.expandedBytes); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stored?.format === 'qbank-state-1') return readStateFile(file, bankId, revision, stored);
      throw new Error('Invalid stored revision');
    }
    return null;
  }

  async function revisionNumbers(bankId) {
    const result = new Set();
    for (const [directory, archived] of [[path.join(states, bankId), false], [path.join(archivedStates, bankId), true]]) {
      let names;
      try { names = await fs.readdir(directory); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) {
        if (!archived && REVISION_FILE.test(name)) result.add(999999999999 - Number(name.slice(0, 12)));
        if (archived && ARCHIVED_REVISION_FILE.test(name)) result.add(999999999999 - Number(name.slice(0, 12)));
      }
    }
    return [...result].sort((a, b) => b - a);
  }

  async function listStates(bankId) {
    assertUuid(bankId, 'bank id');
    const result = [];
    for (const revision of await revisionNumbers(bankId)) {
      const state = await readStateAt(bankId, revision);
      if (state) result.push(state);
    }
    return result;
  }

  async function readState(bankId) {
    assertUuid(bankId, 'bank id');
    const revisions = await revisionNumbers(bankId);
    return revisions.length ? readStateAt(bankId, revisions[0]) : null;
  }

  async function createState(state) {
    assertUuid(state?.bank_id, 'bank id');
    if (!Number.isSafeInteger(state.revision) || state.revision < 1 || state.revision > 999999999998)
      throw new Error('Invalid state revision');
    const directory = path.join(states, state.bank_id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = revisionName(state.revision);
    const archived = path.join(archivedStates, state.bank_id, archivedRevisionName(state.revision));
    try { await fs.access(archived); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
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

  async function readSubmission(bankId, batchId) {
    assertUuid(bankId, 'bank id'); assertUuid(batchId, 'batch id');
    return readPacked(path.join(inbox, bankId, `${batchId}.json`), 2 * LIMITS.requestBytes + 4096);
  }

  async function readOperations(bankId) {
    assertUuid(bankId, 'bank id');
    try { return await readPacked(path.join(operations, bankId, 'pipeline.json'), LIMITS.expandedBytes); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function writeOperations(value) {
    assertUuid(value?.bank_id, 'bank id');
    if (value?.format !== 'qbank-operations-2' || !Number.isSafeInteger(value.current_revision) || value.current_revision < 0)
      throw new Error('Invalid operation pipeline');
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIMITS.expandedBytes) throw new Error('Operation pipeline exceeds limit');
    const file = path.join(operations, value.bank_id, 'pipeline.json');
    const current = await readOperations(value.bank_id);
    if (current && current.current_revision > value.current_revision) return false;
    await writePackedAtomic(file, value);
    return true;
  }

  return { root: base, readState, readStateAt, listStates, createState, createSubmission, readSubmission, readOperations, writeOperations };
}

module.exports = { createFileStore };
