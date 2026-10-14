import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../miniprogram/miniprogram/core/search.ts';
import {seedPayload, prepare} from '../tools/mobile-index/build.mjs';
import {normalize as desktopNormalize, queryTerms as desktopTerms} from '../src/search-presentation.ts';

const base = new URL('../miniprogram/miniprogram/', import.meta.url);
const embeddedText = await readFile(new URL('data/questions.json', base), 'utf8');
const payload = JSON.parse(embeddedText).payload;
const lines = payload.trimEnd().split('\n'), questions = lines.map(line => JSON.parse(line));
const index = JSON.parse(await readFile(new URL('data/index.json', base), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('data/manifest.json', base), 'utf8'));
const bank = () => new core.LocalBank(lines, index);
const fixture = (overrides = {}) => ({...questions[0], stem: '用户与系统', options: [{key: 'A', content: '聊天服务', option_id: 'a'}],
  answer: ['A'], type: 'single', explanation: '只在解析中出现的秘密词', chapter: '第一章', tags: ['标签示例'], ...overrides});
function sampleBank(qs) {
  return new core.LocalBank(qs.map(q => JSON.stringify(q)), {question_count: qs.length,
    release_id: 'sample', schema_version: 'qbank-index-1', postings: core.buildPostings(qs)});
}
const referenceText = q => desktopNormalize([q.stem, q.options.map(o => o.content).join('\n'),
  q.tags.join(' '), q.external_id, q.question_id, q.chapter].join('\n'));

test('generated content is deterministic, retains source metadata and matches desktop identity', async () => {
  const seed = JSON.parse(await readFile(new URL('../src-tauri/resources/seed.json', import.meta.url), 'utf8'));
  assert.equal(payload, seedPayload(seed));
  assert.equal(questions.length, 914);
  assert.equal(manifest.bank_id, 'ad50971f-66af-51c2-bb0e-dc798b03b369');
  assert.equal(manifest.release_id, createHash('sha256').update(payload).digest('hex'));
  assert.equal(Buffer.byteLength(payload), manifest.files[0].size);
  assert.equal(manifest.files[0].path, 'questions.jsonl');
  assert.equal(index.release_id, manifest.release_id);
  for (let i = 0; i < seed.length; i++) {
    for (const field of ['question_id', 'options', 'answer', 'sources', 'stem']) assert.deepEqual(questions[i][field], seed[i][field]);
  }
  assert.equal((await prepare({check: true})).questions, 914);
});

async function loadService(readResource) {
  const source = await readFile(new URL('services/bank.ts', base), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}});
  const exports = {};
  vm.runInNewContext(outputText, {exports, require: () => core,
    wx: {getFileSystemManager: () => ({readFile: readResource})}, console: {error() {}}, Error});
  return exports;
}

test('native loader reads supported JSON resources, restores JSONL and caches the bundle', async () => {
  const paths = [];
  const service = await loadService(options => {
    paths.push(options.filePath);
    // Non-JSON resources were rejected by the actual code-package runtime.
    if (!options.filePath.endsWith('.json')) return options.fail({errMsg: 'permission denied'});
    readFile(new URL(options.filePath, base), 'utf8').then(data => options.success({data}), options.fail);
  });
  const first = service.loadBank(), concurrent = service.loadBank();
  assert.equal(first, concurrent);
  const loaded = await first;
  assert.deepEqual(paths.sort(), ['data/index.json', 'data/manifest.json', 'data/questions.json']);
  assert.equal(loaded.manifest.release_id, manifest.release_id);
  assert.equal(loaded.bank.question(913).question_id, questions[913].question_id);
  assert.deepEqual(await loaded.bank.search('用户 聊天'), await bank().search('用户 聊天'));
  assert.equal(await service.loadBank(), loaded);
  assert.equal(paths.length, 3);
});

test('native loader retries read failures and rejects malformed resource envelopes', async () => {
  const files = {'data/manifest.json': JSON.stringify(manifest), 'data/questions.json': embeddedText, 'data/index.json': JSON.stringify(index)};
  let mode = 'read-failure';
  const service = await loadService(options => {
    if (mode === 'read-failure') return options.fail({errMsg: 'permission denied'});
    const data = options.filePath === 'data/questions.json' && mode === 'bad-envelope'
      ? JSON.stringify({format: 'qbank-embedded-jsonl-1', payload: []}) : files[options.filePath];
    options.success({data});
  });
  await assert.rejects(service.loadBank(), /内置题库读取失败/);
  mode = 'bad-envelope';
  await assert.rejects(service.loadBank(), /资源格式无效/);
  mode = 'success';
  assert.equal((await service.loadBank()).bank.question(0).question_id, questions[0].question_id);
});

test('real index equals independent full-text reference for single characters, phrases and mixed fields', async () => {
  const queries = ['', '天', '用户 聊天', 'ArkTS const 量', '"DevEco Studio"', 'ＡｒｋＴＳ',
    '旧版迁移', 'S-371', 'x不存在的题目词', '"a b"', ...questions.filter((_, i) => i % 37 === 0).map(q => Array.from(q.stem).slice(0, 5).join(''))];
  const engine = bank();
  for (const query of queries) {
    const terms = desktopTerms(query);
    const expected = questions.flatMap((q, id) => terms.every(t => referenceText(q).includes(t)) ? [id] : []);
    assert.deepEqual(await engine.search(query), expected, query);
  }
});

test('cross-field AND, exact phrases, excluded explanation and non-contiguous false positives', async () => {
  const qs = [fixture(), fixture({stem: 'ab xx bc'}), fixture({stem: 'abc'}), fixture({stem: 'ｕｓｅｒ e\u0301 가'})];
  const engine = sampleBank(qs);
  assert.deepEqual(await engine.search('用户 聊天'), [0]);
  assert.deepEqual(await engine.search('秘密词'), []);
  assert.deepEqual(await engine.search('abc'), [2]);
  assert.deepEqual(await engine.search('"用户 聊天"'), []);
  assert.deepEqual(await engine.search('USER é 가'), [3]);
});

test('query limits are explicit and a newer query cancels pending old results', async () => {
  assert.throws(() => core.queryTerms('天'.repeat(301)), /300/);
  assert.throws(() => core.queryTerms(Array(13).fill('天').join(' ')), /12/);
  assert.deepEqual(core.queryTerms('用户 用户 "DevEco Studio"'), ['用户', 'deveco studio']);
  const engine = bank();
  const previous = engine.search('的');
  const newest = engine.search('zzzz无结果');
  assert.deepEqual(await newest, []);
  assert.equal(await previous, null);
  const cancelled = engine.search('的'); engine.cancel();
  assert.equal(await cancelled, null);
});

test('snippets retain all distant matches and full original Unicode glyphs', () => {
  const q = fixture({stem: '用户' + '很长的文字'.repeat(30) + '系统', options: [{key: 'A', content: '聊天', option_id: 'a'}]});
  const segments = core.snippet(q, ['用户', '系统', '聊天']);
  assert.deepEqual(new Set(segments.filter(s => s.color >= 0).map(s => s.color)), new Set([0, 1, 2]));
  assert.ok(segments.map(s => s.text).join('').includes('…'));
  const text = 'Ｆｏｏ e\u0301 ﬃ 가 👩‍💻';
  const result = core.highlight(text, ['foo', 'é', 'ffi', '가', '👩‍💻']);
  assert.equal(result.map(s => s.text).join(''), text);
  assert.deepEqual(result.filter(s => s.color >= 0).map(s => s.text), ['Ｆｏｏ', 'e\u0301', 'ﬃ', '가', '👩‍💻']);
  assert.equal(core.answerText(fixture({answer: null})), '待核对');
  assert.equal(core.answerText(fixture({answer: ['A', 'C']})), 'A、C');
  const spaced = core.snippet(fixture({stem: 'before DevEco  Studio after'}), ['deveco  studio']);
  assert.ok(spaced.some(s => s.color === 0 && s.text === 'DevEco  Studio'));
});

test('variable-height windows bound rendered nodes and reach every row in both directions', () => {
  const layout = new core.VirtualList(914);
  const heights = questions.map((_, i) => 90 + i % 6 * 31);
  layout.measure(0, heights);
  const seen = new Set();
  for (let i = 0; i < 914; i++) {
    const range = layout.window(layout.offset(i), 720);
    assert.ok(range.start <= i && range.end > i);
    assert.ok(range.end - range.start < 30);
    assert.equal(range.before + heights.slice(range.start, range.end).reduce((a, b) => a + b, 0) + range.after, layout.offset(914));
    for (let n = range.start; n < range.end; n++) seen.add(n);
  }
  assert.equal(seen.size, 914);
  assert.equal(layout.window(0, 720).start, 0);
  assert.equal(layout.window(layout.offset(914) - 720, 720).end, 914);
});

async function loadPage(path, mocks = {}) {
  const source = await readFile(new URL(path, base), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}});
  let page;
  const selection = {in() {return this;}, select() {return this;}, selectAll() {return this;}, boundingClientRect() {return this;}, exec() {}};
  const wx = {createSelectorQuery: () => selection, navigateTo: () => {}, ...mocks};
  vm.runInNewContext(outputText, {
    exports: {}, require: name => name.endsWith('/search') ? core : {loadBank: async () => ({bank: bank(), manifest})},
    Page: options => { page = options; }, wx, setTimeout, clearTimeout, Error,
  });
  // WeChat instantiates pages by cloning free data. Tests must not accidentally
  // retain prototypes that would be lost on the actual platform.
  for (const [key, value] of Object.entries(page)) {
    if (value !== undefined && typeof value !== 'function') page[key] = JSON.parse(JSON.stringify(value));
  }
  page.setData = function(values, callback) {Object.assign(this.data, values); callback?.();};
  return page;
}

test('page searches, scrolls, clears errors and navigates with current query context', async () => {
  let navigation;
  const page = await loadPage('pages/index/index.ts', {navigateTo: options => {navigation = options;}});
  assert.equal(page.layout, null);
  await page.onLoad();
  assert.ok(page.layout instanceof core.VirtualList);
  assert.equal(page.data.total, 914);
  assert.ok(page.data.rows.length < 30);
  page.scrollPosition = 6000; page.renderRows();
  assert.ok(page.data.before > 0);
  page.data.query = '天'; await page.runSearch('天');
  assert.equal(page.data.before, 0);
  assert.equal(page.data.scrollTop, 0);
  page.onOpen({currentTarget: {dataset: {id: page.ids[0]}}});
  assert.ok(navigation.url.includes(page.bank.question(page.ids[0]).question_id));
  let context;
  navigation.success({eventChannel: {emit: (_, payload) => {context = payload;}}});
  assert.equal(context.query, '天');
  await page.runSearch('天'.repeat(301));
  assert.match(page.data.error, /300/);
  assert.equal(page.data.rows.length, 0);
  await page.runSearch('');
  assert.equal(page.data.count, 914);
  page.onUnload();
});

test('detail retains complete stem/options/answer and highlights a query passed through the event channel', async () => {
  const page = await loadPage('pages/detail/detail.ts');
  page.getOpenerEventChannel = () => ({on: (_, handler) => handler({query: '天'})});
  const id = (await bank().search('天'))[0], q = questions[id];
  await page.onLoad({row: String(id), id: q.question_id});
  assert.equal(page.data.error, '');
  assert.equal(page.data.stem.map(s => s.text).join(''), q.stem);
  assert.equal(page.data.options.length, q.options.length);
  assert.equal(page.data.answer, core.answerText(q));
  page.onUnload();
});
