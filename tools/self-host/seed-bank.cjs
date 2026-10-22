'use strict';

// One-time explicit seed helper. It refuses to overwrite an existing state.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
function runtimeModule(name) {
  try { return require(path.join(__dirname, name)); }
  catch { return require(path.join(__dirname, '../../cloud/qbank-auth', name)); }
}
const { createFileStore } = runtimeModule('fs-store.cjs');
const { releaseName } = runtimeModule('projection.cjs');

const [input, root = process.env.QBANK_STORAGE_ROOT || '/var/lib/qbank-auth'] = process.argv.slice(2);
if (!input) { console.error('用法：node tools/self-host/seed-bank.cjs <questions.json> [storage-root]'); process.exit(2); }
const wrapper = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'));
const lines = typeof wrapper.payload === 'string' ? wrapper.payload.split(/\r?\n/).filter(Boolean) : [];
const questions = lines.map(line => JSON.parse(line)).map(question => ({ ...question, status: 'verified' }));
if (!questions.length) throw new Error('题库文件没有题目');
const first = questions[0];
const bankId = first.bank_id || process.env.QBANK_SEED_BANK_ID || 'ad50971f-66af-51c2-bb0e-dc798b03b369';
const name = first.bank || process.env.QBANK_SEED_BANK_NAME || 'HarmonyOS 初级认证';
const at = process.env.QBANK_SEED_AT || new Date().toISOString();
const releaseId = createHash('sha256').update(JSON.stringify(questions)).digest('hex');
const state = { format: 'qbank-state-1', bank_id: bankId, name, revision: 1, release_version: 1,
  formal: questions, pending: [], resolved: [], batches: [], updated_at: at, merged_at: at,
  release_id: releaseId, release_name: releaseName(at, name, '初建', 1, bankId, releaseId) };
const store = createFileStore({ root });
if (await store.readState(bankId)) throw new Error('目标题库已有状态，拒绝覆盖');
if (!await store.createState(state)) throw new Error('题库状态已存在，拒绝覆盖');
console.log(JSON.stringify({ bank_id: bankId, name, revision: 1, release_version: 1, question_count: questions.length, release_name: state.release_name, storage_root: store.root }));
