import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildPostings} from '../../miniprogram/miniprogram/core/search.ts';
import {encodeCompact, encodeCompactBundle} from '../../miniprogram/miniprogram/core/compact.ts';
import {brotliCompressSync, constants} from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = resolve(root, 'miniprogram/miniprogram/data');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Match Rust Question/Choice field order and serde_json::Value's sorted maps.
// Published JSONL is consumed byte-for-byte, without re-serializing its payload.
const sortedValue = v => Array.isArray(v) ? v.map(sortedValue) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortedValue(v[k])])) : v;
export function seedPayload(seed) {
  return seed.map(q => JSON.stringify({
    schema_version: q.schema_version ?? '1.0', question_id: q.question_id, base_revision: q.base_revision ?? 1,
    ...(q.recorded_at!=null?{recorded_at:q.recorded_at}:{}),...(q.updated_at!=null?{updated_at:q.updated_at}:{}),...(q.recorded_at_source?{recorded_at_source:q.recorded_at_source}:{}),
    type: q.type, stem: q.stem,
    options: q.options.map(o => ({key: o.key, content: o.content, option_id: o.option_id})),
    answer: q.answer, external_id: q.external_id ?? '', bank: q.bank ?? '', chapter: q.chapter ?? '',
    explanation: q.explanation ?? '', tags: q.tags ?? [], difficulty: q.difficulty ?? '',
    applicable_version: q.applicable_version ?? '', source_note: q.source_note ?? '',
    status: q.status ?? 'unreviewed', issues: q.issues ?? [], sources: (q.sources ?? []).map(sortedValue),
    attachments: q.attachments ?? [], extensions: q.extensions ?? null,
  })).join('\n') + '\n';
}

async function readPublishedSource(sourceDirectory) {
  const payload = await readFile(resolve(sourceDirectory, 'questions.jsonl'));
  const manifest = JSON.parse(await readFile(resolve(sourceDirectory, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== '1.0' || manifest.release_id !== sha256(payload)
      || manifest.files?.length !== 1 || manifest.files[0].path !== 'questions.jsonl'
      || manifest.files[0].sha256 !== sha256(payload) || manifest.files[0].size !== payload.length) {
    throw new Error(`${sourceDirectory} 的发布清单、大小或 SHA-256 与 questions.jsonl 不一致`);
  }
  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(payload);
  const questions = text.trimEnd().split('\n').map(line => JSON.parse(line));
  if (questions.length !== manifest.question_count || !questions.length) throw new Error(`${manifest.name} 题数不一致或为空`);
  const ids = new Set();
  for (const q of questions) {
    if (!q.question_id || ids.has(q.question_id) || !['1.0','1.1'].includes(q.schema_version)
        || !['single', 'multiple', 'true_false', 'programming'].includes(q.type) || !q.stem?.trim()
        || !Array.isArray(q.options) || !Array.isArray(q.tags)
        || (q.attachments?.length ?? 0) || q.extensions != null) throw new Error(`${manifest.name} 存在无效记录、重复 ID 或不支持的附件`);
    if (q.answer === null ? (q.type !== 'programming' && q.status !== 'needs_review')
      : q.type === 'true_false' ? typeof q.answer !== 'boolean'
      : !Array.isArray(q.answer) || !q.answer.length || q.answer.some(key => !q.options.some(o => o.key === key))) {
      throw new Error(`答案格式无效：${q.question_id}`);
    }
    ids.add(q.question_id);
  }
  return {payload, text, manifest, questions};
}

function bundleDefaultSources() {
  return ['basic', 'advanced'].map(name => resolve(root, 'tools/mobile-index/sources', name));
}

export async function prepareBundle({check = false, sourceDirectories = bundleDefaultSources()} = {}) {
  if (sourceDirectories.length < 2) throw new Error('内置题库包至少需要两个题库源');
  const sources = await Promise.all(sourceDirectories.map(readPublishedSource));
  const bundle = encodeCompactBundle(sources.map(source => ({bankId: source.manifest.bank_id,
    release: source.manifest.release_id, questions: source.questions})));
  const indexes = Object.fromEntries(sources.map(source => [source.manifest.bank_id, {
    schema_version: 'qbank-index-1', release_id: source.manifest.release_id,
    question_count: source.questions.length, postings: buildPostings(source.questions),
  }]));
  const manifests = sources.map(source => source.manifest);
  // Keep the first bank's JSON files as a small diagnostic/legacy view. They are
  // excluded from the code package; manifest.ts and compact.br contain both banks.
  const primary = sources[0];
  const primaryIndex = indexes[primary.manifest.bank_id];
  const files = new Map([
    ['compact.br', brotliCompressSync(Buffer.from(JSON.stringify(bundle)),
      {params: {[constants.BROTLI_PARAM_QUALITY]: 11}})],
    ['questions.json', Buffer.from(JSON.stringify({format: 'qbank-embedded-jsonl-1', payload: primary.text}) + '\n')],
    ['manifest.json', Buffer.from(JSON.stringify(primary.manifest) + '\n')],
    ['manifest.ts', Buffer.from('// Generated by tools/mobile-index/build.mjs; do not edit.\n'
      + 'export const bundledManifests = ' + JSON.stringify(manifests) + ';\n'
      + 'export const bundledManifest = bundledManifests[0];\n')],
    ['index.json', Buffer.from(JSON.stringify(primaryIndex) + '\n')],
    ['bundle-manifest.json', Buffer.from(JSON.stringify({format: 'qbank-embedded-manifest-1', banks: manifests}) + '\n')],
    ['bundle-index.json', Buffer.from(JSON.stringify({format: 'qbank-index-bundle-1', banks: indexes}) + '\n')],
  ]);
  const dataBytes = [...files.entries()].filter(([name]) => name !== 'compact.br').reduce((sum, [, data]) => sum + data.length, 0);
  const compactBytes = files.get('compact.br').length;
  if (compactBytes > 1400 * 1024) throw new Error(`压缩数据 ${compactBytes} 字节超过 1400 KiB 预算，请减少题目并重新测量最终包体积`);
  if (!check) await mkdir(destination, {recursive: true});
  for (const [name, data] of files) {
    const target = resolve(destination, name);
    if (check) {
      if (!(await readFile(target)).equals(data)) throw new Error(`${name} 已过期，请运行 pnpm prepare:miniprogram`);
    } else await writeFile(target, data);
  }
  return {questions: manifests.map(manifest => ({bank_id: manifest.bank_id, name: manifest.name, count: manifest.question_count})),
    compactBytes, dataBytes, mode: check ? 'checked' : 'generated', source: 'local-desktop-banks'};
}

export async function prepare({check = false, sourceDirectory} = {}) {
  let payload, manifest;
  if (sourceDirectory) {
    payload = await readFile(resolve(sourceDirectory, 'questions.jsonl'));
    manifest = JSON.parse(await readFile(resolve(sourceDirectory, 'manifest.json'), 'utf8'));
  } else {
    const seed = JSON.parse(await readFile(resolve(root, 'desktop/src-tauri/resources/seed.json'), 'utf8'));
    payload = Buffer.from(seedPayload(seed));
    manifest = {
      schema_version: '1.0', bank_id: 'ad50971f-66af-51c2-bb0e-dc798b03b369', name: 'HarmonyOS 初级认证',
      release_id: sha256(payload), release_version: 1, published_at: '2026-10-14T00:00:00Z',
      min_app_version: '0.1.0', question_count: seed.length,
      files: [{path: 'questions.jsonl', sha256: sha256(payload), size: payload.length}],
    };
  }
  if (manifest.schema_version !== '1.0' || manifest.release_id !== sha256(payload)
      || manifest.files?.length !== 1 || manifest.files[0].path !== 'questions.jsonl'
      || manifest.files[0].sha256 !== sha256(payload) || manifest.files[0].size !== payload.length) {
    throw new Error('发布清单、大小或 SHA-256 与 questions.jsonl 不一致');
  }
  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(payload);
  const questions = text.trimEnd().split('\n').map(line => JSON.parse(line));
  if (questions.length !== manifest.question_count || !questions.length) throw new Error('题数不一致或空题库');
  const ids = new Set();
  for (const q of questions) {
    if (!q.question_id || ids.has(q.question_id) || !['1.0','1.1'].includes(q.schema_version)
        || !['single', 'multiple', 'true_false', 'programming'].includes(q.type) || !q.stem?.trim()
        || !Array.isArray(q.options) || !Array.isArray(q.tags)
        || (q.attachments?.length ?? 0) || q.extensions != null) throw new Error('题库存在无效记录、重复 ID 或不支持的附件');
    if (q.answer === null ? (q.type !== 'programming' && q.status !== 'needs_review')
      : q.type === 'true_false' ? typeof q.answer !== 'boolean'
      : !Array.isArray(q.answer) || !q.answer.length || q.answer.some(key => !q.options.some(o => o.key === key))) {
      throw new Error(`答案格式无效：${q.question_id}`);
    }
    ids.add(q.question_id);
  }
  const index = {schema_version: 'qbank-index-1', release_id: manifest.release_id,
    question_count: questions.length, postings: buildPostings(questions)};
  const files = new Map([
    ['compact.br', brotliCompressSync(Buffer.from(JSON.stringify(encodeCompact(questions, manifest.release_id))),
      {params: {[constants.BROTLI_PARAM_QUALITY]: 11}})],
    // WeChat code-package reads reject .jsonl/.txt in the tested runtime.
    // A JSON string envelope round-trips the original JSONL, including newlines
    // and field order; release_id still identifies the decoded standard payload.
    ['questions.json', Buffer.from(JSON.stringify({format: 'qbank-embedded-jsonl-1', payload: text}) + '\n')],
    ['manifest.json', Buffer.from(JSON.stringify(manifest) + '\n')],
    ['manifest.ts', Buffer.from('// Generated by tools/mobile-index/build.mjs; do not edit.\nexport const bundledManifest = ' + JSON.stringify(manifest) + ';\n')],
    ['index.json', Buffer.from(JSON.stringify(index) + '\n')],
  ]);
  // Legacy JSON/index remain build/test inputs but are excluded from the code package.
  const dataBytes = [...files.entries()].filter(([name]) => name !== 'compact.br').reduce((sum, [, data]) => sum + data.length, 0);
  const compactBytes = files.get('compact.br').length;
  if (compactBytes > 1400 * 1024) throw new Error(`压缩数据 ${compactBytes} 字节超过 1400 KiB 预算，请减少题目并重新测量最终包体积`);
  if (!check) await mkdir(destination, {recursive: true});
  for (const [name, data] of files) {
    const target = resolve(destination, name);
    if (check) {
      if (!(await readFile(target)).equals(data)) throw new Error(`${name} 已过期，请运行 pnpm prepare:miniprogram`);
    } else await writeFile(target, data);
  }
  return {questions: questions.length, release_id: manifest.release_id, dataBytes, compactBytes: files.get('compact.br').length,
    mode: check ? 'checked' : 'generated', source: sourceDirectory ? 'published-v1' : 'desktop-seed'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), sourceDirectories = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--source') {
    if (!args[i + 1]) throw new Error('--source 需要已解压的 v1 包目录');
    sourceDirectories.push(resolve(args[++i]));
  }
  const result = args.includes('--bundle')
    ? await prepareBundle({check: args.includes('--check'), sourceDirectories: sourceDirectories.length ? sourceDirectories : undefined})
    : await prepare({check: args.includes('--check'), sourceDirectory: sourceDirectories[0]});
  console.log(JSON.stringify(result, null, 2));
}
