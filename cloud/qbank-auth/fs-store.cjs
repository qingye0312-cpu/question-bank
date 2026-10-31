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

  async function readRollbackRef(ref, bankId, revision, seen) {
    if (ref?.format !== 'qbank-rollback-ref-1' || ref.bank_id !== bankId
      || ref.revision !== revision || !Number.isSafeInteger(ref.from_revision)
      || ref.from_revision < 1 || ref.from_revision >= revision
      || !Number.isSafeInteger(ref.target_revision) || ref.target_revision < 1
      || ref.target_revision >= revision || typeof ref.name !== 'string' || !ref.name.trim()
      || !Number.isSafeInteger(ref.release_version) || (ref.release_version_label != null && (typeof ref.release_version_label !== 'string' || !/^v\d+(?:\.\d+)?$/.test(ref.release_version_label))) || typeof ref.updated_at !== 'string'
      || typeof ref.rollback_at !== 'string' || typeof ref.release_id !== 'string'
      || typeof ref.release_name !== 'string' || !ref.operation || typeof ref.operation.id !== 'string')
      throw new Error('Invalid rollback reference');
    const parent = await readStateAt(bankId, ref.from_revision, seen);
    const target = await readStateAt(bankId, ref.target_revision, seen);
    if (!parent || !target || target.formal === null) throw new Error('Rollback reference target is missing');
    const formal = structuredClone(target.formal).map(question => ({ ...question, bank: ref.name }));
    return {
      ...parent,
      rollback_reference: true,
      bank_id: bankId,
      name: ref.name,
      revision,
      release_version: ref.release_version,
      release_version_label: ref.release_version_label || `v${ref.release_version}`,
      formal,
      pending: [],
      resolved: structuredClone(target.resolved || []),
      batches: structuredClone(target.batches || []),
      merge_history: structuredClone(target.merge_history || []),
      updated_at: ref.updated_at,
      merged_at: ref.merged_at,
      release_id: ref.release_id,
      release_name: ref.release_name,
      rollback: ref.rollback,
      rollback_at: ref.rollback_at,
      seed_uploader_account_id: null,
      seed_uploader_real_name: null,
      operations: [...(parent.operations || []), ref.operation],
    };
  }

  async function readStateAt(bankId, revision, seen = new Set()) {
    assertUuid(bankId, 'bank id');
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 999999999998) return null;
    if (seen.has(revision)) throw new Error('Rollback reference cycle');
    const name = revisionName(revision);
    for (const [directory, filename] of [[path.join(states, bankId), name], [path.join(archivedStates, bankId), archivedRevisionName(revision)]]) {
      const file = path.join(directory, filename);
      let stored;
      try { stored = await readPacked(file, LIMITS.expandedBytes); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stored?.format === 'qbank-state-1') return readStateFile(file, bankId, revision, stored);
      if (stored?.format === 'qbank-rollback-ref-1') {
        const nextSeen = new Set(seen); nextSeen.add(revision);
        return readRollbackRef(stored, bankId, revision, nextSeen);
      }
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

  async function archiveState(bankId, revision) {
    const name = revisionName(revision), source = path.join(states, bankId, name), sourceDirectory = path.dirname(source);
    const destinationDirectory = path.join(archivedStates, bankId), destination = path.join(destinationDirectory, archivedRevisionName(revision));
    await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    try {
      await fs.link(source, destination);
      let directory = await fs.open(destinationDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') {
        try { await fs.access(destination); return; }
        catch (missing) { if (missing.code === 'ENOENT') throw new Error('Rollback source revision is missing'); throw missing; }
      }
      if (error.code !== 'EEXIST') throw error;
      const [original, archived] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
      if (!original.equals(archived)) throw new Error('Archived state revision conflicts with current state');
    }
    await fs.unlink(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const directory = await fs.open(sourceDirectory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async function createState(state) {
    assertUuid(state?.bank_id, 'bank id');
    if (!Number.isSafeInteger(state.revision) || state.revision < 1 || state.revision > 999999999998)
      throw new Error('Invalid state revision');
    const directory = path.join(states, state.bank_id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = revisionName(state.revision);
    for (const existing of [path.join(archivedStates, state.bank_id, archivedRevisionName(state.revision))]) {
      try { await fs.access(existing); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      await writePackedExclusive(path.join(directory, name), state);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }

  async function createRollback(state, targetRevision, operation) {
    assertUuid(state?.bank_id, 'bank id');
    const fromRevision = state?.rollback?.from_revision;
    if (!Number.isSafeInteger(state.revision) || state.revision < 2 || state.revision > 999999999998
      || !Number.isSafeInteger(fromRevision) || fromRevision !== state.revision - 1
      || !Number.isSafeInteger(targetRevision) || targetRevision < 1 || targetRevision >= fromRevision)
      throw new Error('Invalid rollback revision');
    const parent = await readStateAt(state.bank_id, fromRevision), target = await readStateAt(state.bank_id, targetRevision);
    if (!parent || !target || target.formal === null) throw new Error('Rollback source state is missing');
    const file = path.join(states, state.bank_id, revisionName(state.revision));
    const archived = path.join(archivedStates, state.bank_id, archivedRevisionName(state.revision));
    const ref = {
      format: 'qbank-rollback-ref-1', bank_id: state.bank_id, revision: state.revision,
      name: state.name, from_revision: fromRevision, target_revision: targetRevision,
      release_version: state.release_version, release_version_label: state.release_version_label || `v${state.release_version}`, updated_at: state.updated_at,
      merged_at: state.merged_at || null, release_id: state.release_id,
      release_name: state.release_name, rollback: state.rollback,
      rollback_at: state.rollback_at, operation,
    };
    try { await fs.access(archived); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try { await writePackedExclusive(file, ref); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readPacked(file, LIMITS.expandedBytes);
      if (existing?.format !== ref.format || existing.operation?.id !== operation.id || existing.operation?.hash !== operation.hash)
        return false;
    }
    // Publish the small reference first. If archiving is interrupted, the
    // reference still resolves against the original source; retries finish it.
    await archiveState(state.bank_id, fromRevision);
    return true;
  }

  async function finalizeRollback(bankId, revision) {
    assertUuid(bankId, 'bank id');
    if (!Number.isSafeInteger(revision) || revision < 2) return false;
    const files = [
      path.join(states, bankId, revisionName(revision)),
      path.join(archivedStates, bankId, archivedRevisionName(revision)),
    ];
    for (const file of files) {
      let ref;
      try { ref = await readPacked(file, LIMITS.expandedBytes); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (ref?.format !== 'qbank-rollback-ref-1' || ref.bank_id !== bankId || ref.revision !== revision) return false;
      await readStateAt(bankId, revision);
      await archiveState(bankId, ref.from_revision);
      return true;
    }
    return false;
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

  return { root: base, readState, readStateAt, listStates, createState, createRollback, finalizeRollback, createSubmission, readSubmission, readOperations, writeOperations };
}

module.exports = { createFileStore };
