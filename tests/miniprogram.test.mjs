import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as intakeCore from '../shared/intake.ts';
import * as answerPresentationCore from '../shared/answer-presentation.ts';
import {applicationFields} from '../miniprogram/miniprogram/services/maintainer-application.ts';
import * as core from '../miniprogram/miniprogram/core/search.ts';
import * as compact from '../miniprogram/miniprogram/core/compact.ts';
import {brotliDecompressSync} from 'node:zlib';
import {seedPayload, prepare} from '../tools/mobile-index/build.mjs';
import {normalize as desktopNormalize, queryTerms as desktopTerms} from '../src/search-presentation.ts';

const base = new URL('../miniprogram/miniprogram/', import.meta.url);
const embeddedText = await readFile(new URL('data/questions.json', base), 'utf8');
const payload = JSON.parse(embeddedText).payload;
const lines = payload.trimEnd().split('\n'), questions = lines.map(line => JSON.parse(line));
const index = JSON.parse(await readFile(new URL('data/index.json', base), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('data/manifest.json', base), 'utf8'));
const compactText = brotliDecompressSync(await readFile(new URL('data/compact.br', base))).toString('utf8');
const readCompressed = readResource => options => readResource({filePath: 'data/compact.br',
  success: result => {const b = Buffer.from(result.data); options.success({data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)});}, fail: options.fail});
const bank = () => new core.LocalBank(lines, index);
const fixture = (overrides = {}) => ({...questions[0], stem: '用户与系统', options: [{key: 'A', content: '聊天服务', option_id: 'a'}],
  answer: ['A'], type: 'single', explanation: '只在解析中出现的秘密词', chapter: '第一章', tags: ['标签示例'], ...overrides});
function sampleBank(qs) {
  return new core.LocalBank(qs.map(q => JSON.stringify(q)), {question_count: qs.length,
    release_id: 'sample', schema_version: 'qbank-index-1', postings: core.buildPostings(qs)});
}
const referenceText = q => desktopNormalize([q.stem, q.options.map(o => o.content).join('\n'),
  q.tags.join(' '), q.external_id, q.question_id, q.chapter].join('\n'));

// Route regex literals through an older-engine constructor too: simply replacing
// global RegExp would leave literals running on Node's newer Unicode engine.
function androidSearchCore() {
  const cache = new Map();
  function AndroidRegExp(pattern, flags) {
    if (/\\[pP]\{|\\u\{/.test(pattern)) throw new SyntaxError('Invalid regular expression: Invalid property name');
    return new RegExp(pattern, flags);
  }
  function load(file) {
    if (cache.has(file.href)) return cache.get(file.href);
    const exports = {};
    cache.set(file.href, exports);
    const {outputText} = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
      transformers: {before: [context => {
        const visit = node => {
          if (ts.isRegularExpressionLiteral(node)) {
            const end = node.text.lastIndexOf('/');
            return context.factory.createNewExpression(context.factory.createIdentifier('RegExp'), undefined,
              [node.text.slice(1, end), node.text.slice(end + 1)].map(s => context.factory.createStringLiteral(s)));
          }
          return ts.visitEachChild(node, visit, context);
        };
        return node => ts.visitNode(node, visit);
      }]},
    });
    vm.runInNewContext(outputText, {exports, RegExp: AndroidRegExp, Intl: undefined, setTimeout,
      require: name => load(new URL(name.endsWith('.js') ? name : `${name}.ts`, file))}, {filename: file.pathname});
    return exports;
  }
  return load(new URL('core/search.ts', base));
}

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

async function loadService(readResource, extra = {}) {
  const source = await readFile(new URL('services/bank.ts', base), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}});
  const exports = {};
  const intake = await import('../shared/intake.ts');
  const sync = await import('../shared/sync.ts');
  vm.runInNewContext(outputText, {exports, require: name => name==='./draft-repository'?{readDraftFile:async()=>[]}:name==='./sync'?{cachedSnapshot:async()=>null,cloudCatalog:()=>[],restoreCatalog:async()=>{}}:name.endsWith('/core/sync')||name==='../core/sync'?sync:name.endsWith('/manifest') ? {bundledManifest: manifest} : name.endsWith('/compact') ? compact : name.endsWith('/intake-store') ? {readLocal:async()=>({version:1,banks:[],entries:[],batches:[]})} : name.endsWith('/intake') ? intake : core,
    wx: {env: {USER_DATA_PATH: '/cache'}, getFileSystemManager: () => ({readFile: readResource, readCompressedFile: readCompressed(readResource)}), ...extra}, console: {error() {}, info() {}, warn() {}}, Error});
  return exports;
}

test('native loader reads supported JSON resources, restores JSONL and caches the bundle', async () => {
  const paths = [];
  const service = await loadService(options => {
    paths.push(options.filePath);
    if (options.filePath === 'data/manifest.json') return options.success({data: JSON.stringify(manifest)});
    if (options.filePath === 'data/compact.br') return options.success({data: compactText});
    options.fail({errMsg: 'no cache'});
  });
  const first = service.loadBank(), concurrent = service.loadBank();
  assert.equal(first, concurrent);
  const loaded = await first;
  assert.deepEqual([...paths].sort(), ['/cache/qbank-runtime-index-v1.json', 'data/compact.br']);
  assert.equal(loaded.manifest.release_id, manifest.release_id);
  assert.equal(loaded.bank.question(913).question_id, questions[913].question_id);
  assert.deepEqual(await loaded.bank.search('用户 聊天'), await bank().search('用户 聊天'));
  assert.equal(await service.loadBank(), loaded);
  assert.equal(paths.length, 2);
  assert.equal(service.startupMetrics.source, 'generated');
  assert.equal(service.startupMetrics.cacheSaved, false);
});

test('native loader retries read failures and rejects malformed resource envelopes', async () => {
  let mode = 'read-failure';
  const disk = new Map();
  const fs = {
    readFile: options => {
      if (options.filePath === 'data/manifest.json') return options.success({data: JSON.stringify(manifest)});
      if (options.filePath === 'data/compact.br' && mode !== 'read-failure') return options.success({data: mode === 'bad-envelope' ? '[]' : compactText});
      if (disk.has(options.filePath)) return options.success({data: disk.get(options.filePath)});
      options.fail({errMsg: 'not found'});
    },
    writeFile: o => {disk.set(o.filePath, o.data); o.success();},
    rename: o => {disk.set(o.newPath, disk.get(o.oldPath)); disk.delete(o.oldPath); o.success();},
  };
  fs.readCompressedFile = readCompressed(fs.readFile);
  const service = await loadService(fs.readFile, {
    getFileSystemManager: () => fs,
    downloadFile: () => assert.fail('embedded mode must never download'),
  });
  await assert.rejects(service.loadBank(), /not found/);
  mode = 'bad-envelope';
  await assert.rejects(service.loadBank(), /资源格式无效/);
  assert.equal(disk.has('/cache/qbank-runtime-index-v1.json'), false);
  mode = 'success';
  assert.equal((await service.loadBank()).bank.question(0).question_id, questions[0].question_id);
  const offline = await loadService(fs.readFile, {downloadFile: () => assert.fail('cached startup must not download')});
  assert.equal((await offline.loadBank()).manifest.question_count, 914);
  assert.equal(offline.startupMetrics.source, 'cache');
  assert.deepEqual(JSON.parse(JSON.parse(disk.get('/cache/qbank-runtime-index-v1.json')).payload), index);
  disk.set('/cache/qbank-runtime-index-v1.json', '{broken');
  const repaired = await loadService(fs.readFile, {getFileSystemManager: () => fs});
  assert.equal((await repaired.loadBank()).manifest.question_count, 914);
  assert.equal(repaired.startupMetrics.source, 'generated');
});

test('runtime index matches build-time index exactly', async () => {
  assert.deepEqual(await core.buildPostingsFromLines(lines), Object.assign(Object.create(null), index.postings));
});

test('Brotli mobile projection preserves all displayed/searchable data and identical index', async () => {
  const decoded = compact.decodeCompact(JSON.parse(compactText), manifest.release_id, 914);
  decoded.forEach((line, i) => {
    const q = JSON.parse(line), original = questions[i];
    for (const field of ['question_id', 'external_id', 'type', 'stem', 'answer', 'chapter', 'tags', 'explanation']) {
      assert.deepEqual(q[field], original[field], field);
    }
    assert.deepEqual(q.options.map(({key, content}) => ({key, content})), original.options.map(({key, content}) => ({key, content})));
  });
  assert.deepEqual(await core.buildPostingsFromLines(decoded), Object.assign(Object.create(null), index.postings));
  assert.throws(() => compact.decodeCompact(JSON.parse(compactText), 'wrong-release', 914), /版本/);
  assert.throws(() => brotliDecompressSync(Buffer.from('broken')), /./);
  assert.equal(compact.decodeUtf8(new TextEncoder().encode('中文👩‍💻é').buffer), '中文👩‍💻é');
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

test('Android search highlighting needs neither Unicode regex extensions nor Intl.Segmenter', () => {
  const android = androidSearchCore();
  for (const [text, term, expected] of [
    ['中文题目', '题目', '题目'], ['Ｆｏｏ', 'foo', 'Ｆｏｏ'], ['ﬃ', 'ffi', 'ﬃ'],
    ['e\u0301', 'é', 'e\u0301'], ['x\u0301', 'x', 'x\u0301'], ['가', '가', '가'],
    ['क\u093f', 'क', 'क\u093f'], ['x\u20dd', 'x', 'x\u20dd'],
    ['a\u{1d165}', 'a', 'a\u{1d165}'], ['汉\u{e0100}', '汉', '汉\u{e0100}'],
    ['☀\ufe0f', '☀', '☀\ufe0f'], ['👍🏽', '👍', '👍🏽'], ['👩🏽‍💻', '💻', '👩🏽‍💻'],
  ]) {
    const segments = android.highlight(`前${text}后`, [term]);
    assert.equal(segments.map(s => s.text).join(''), `前${text}后`);
    assert.equal(segments.filter(s => s.color === 0).map(s => s.text).join(''), expected);
    assert.equal(android.highlight(text, []).map(s => s.text).join(''), text);
  }
  const q = fixture({stem: '前'.repeat(120) + '👩🏽‍💻 e\u0301' + '后'.repeat(120)});
  const excerpt = android.snippet(q, ['💻', 'é']);
  assert.equal(excerpt.filter(s => s.color === 0).map(s => s.text).join(''), '👩🏽‍💻');
  assert.equal(excerpt.filter(s => s.color === 1).map(s => s.text).join(''), 'e\u0301');
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

async function loadPage(path, mocks = {}, searchCore = core, services = {}) {
  const source = await readFile(new URL(path, base), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}});
  let page;
  const selection = {in() {return this;}, select() {return this;}, selectAll() {return this;}, boundingClientRect() {return this;}, exec() {}};
  const wx = {createSelectorQuery: () => selection, navigateTo: () => {}, ...mocks};
  vm.runInNewContext(outputText, {
    exports: {}, require: name => name.endsWith('/appearance') ? {themePageData:()=>({}),showPageTheme:()=>{},hidePageTheme:()=>{}}
      : name.endsWith('/foreground') ? {foregroundGeneration:()=>1}
      : name.endsWith('/maintainer-application') ? {applicationFields}
      : name.endsWith('/intake-controller') ? services.controller
      : name.endsWith('/cloud') ? services.cloud
      : name.endsWith('/search') ? searchCore
      : name.endsWith('/intake') ? intakeCore
      : name.endsWith('/answer-presentation') ? answerPresentationCore
      : name.endsWith('/bank') ? (services.bank||{loadBank: async () => ({bank: bank(), manifest}),listBanks:async()=>[{id:manifest.bank_id,name:manifest.name}],activeBankId:()=>manifest.bank_id,selectBank:()=>{}})
      : name.endsWith('/sync') ? (services.sync||{cloudCatalog:()=>[],refreshCatalog:async()=>{},syncBank:async()=>false})
      : name.endsWith('/share') ? (services.share||{})
      : {APP_VERSION:'0.2.7'},
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

test('home page share callbacks open the same public bank and restore its search query', async () => {
  const sharedBankId='public-bank-id';let selectedBank='',catalogLoaded=false,refreshCalls=0;
  const page = await loadPage('pages/index/index.ts', {}, core, {
    bank:{loadBank:async id=>({bank:bank(),manifest:{...manifest,bank_id:id,name:id===sharedBankId?'共享题库':manifest.name}}),
      listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},...(catalogLoaded?[{id:sharedBankId,name:'共享题库'}]:[])],
      activeBankId:()=>manifest.bank_id,selectBank:id=>{selectedBank=id;}},
    sync:{cloudCatalog:()=>catalogLoaded?[{bank_id:sharedBankId}]:[],refreshCatalog:async()=>{catalogLoaded=true;refreshCalls++;},syncBank:async()=>false},
  });
  await page.onLoad({bank:sharedBankId,q:'云端 API'});
  assert.equal(refreshCalls,1);
  assert.equal(page.data.bankId,sharedBankId);
  assert.equal(selectedBank,sharedBankId);
  assert.equal(page.data.query,'云端 API');
  const appShare=page.onShareAppMessage({from:'menu'});
  assert.equal(appShare.path,`/pages/index/index?bank=${sharedBankId}&q=${encodeURIComponent('云端 API')}`);
  assert.match(appShare.title,/共享题库/);
  const timelineShare=page.onShareTimeline();
  assert.equal(timelineShare.query,`bank=${sharedBankId}&q=${encodeURIComponent('云端 API')}`);
  assert.match(timelineShare.title,/共享题库/);
  page.onUnload();
});

test('home page share links do not expose a private local bank id or its query', async () => {
  const privateBankId='private-local-bank-id';
  const page = await loadPage('pages/index/index.ts', {}, core, {
    bank:{loadBank:async id=>({bank:bank(),manifest:{...manifest,bank_id:id,name:'私人本地题库',release_id:'local'}}),
      listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},{id:privateBankId,name:'私人本地题库'}],
      activeBankId:()=>privateBankId,selectBank:()=>{}},
    sync:{cloudCatalog:()=>[],refreshCatalog:async()=>{},syncBank:async()=>false},
  });
  await page.onLoad({q:'仅本机可见的搜索词'});
  const share=page.onShareAppMessage({from:'menu'});
  assert.equal(share.path,'/pages/index/index');
  assert.equal(share.title,'知屿题库 · 离线题库');
  assert.equal(page.onShareTimeline().query,'');
  page.onUnload();
});

test('shared bank JSON exports the current library and imports it as a separate local copy', async () => {
  const source = await readFile(new URL('../miniprogram/miniprogram/services/share.ts', import.meta.url), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}});
  const files = new Map();let selected='',serial=1;
  const imported = {version:1,banks:[],batches:[],entries:[]};
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const wx = {env:{USER_DATA_PATH:'/user'},getFileSystemManager:()=>({
    writeFile:options=>{files.set(options.filePath,options.data);options.success?.();},
    rename:options=>{files.set(options.newPath,files.get(options.oldPath));files.delete(options.oldPath);options.success?.();},
  })};
  const exports={};
  const bundle={bank:sampleBank(questions),manifest:{...manifest,name:'共享源题库'}};
  const mocks={
    bank:{loadBank:async()=>bundle,invalidateBank:()=>{},selectBank:value=>{selected=value;}},
    store:{readLocal:async()=>imported,updateLocal:async change=>change(imported),createIds:async()=>()=>id(serial++)},
  };
  // Re-evaluate with dependency injection so the test uses the real checksum and schema validators.
  vm.runInNewContext(outputText,{exports,wx,Date,JSON,Array,Set,Error,Math,Number,String,Object,RegExp,
    require:name=>name.endsWith('/bank')?mocks.bank:name.endsWith('/intake-store')?mocks.store:intakeCore}, {filename:'services/share.ts'});
  const output=await exports.exportBankJson(manifest.bank_id);
  const document=JSON.parse(files.get(output.filePath));
  assert.equal(document.format,'qbank-bank-json-1');
  assert.equal(document.question_count,914);
  assert.equal(document.questions[0].bank,'共享源题库');
  const result=await exports.importSharedBankJson(files.get(output.filePath));
  assert.equal(result.name,'共享源题库（分享副本）');
  assert.equal(result.added,914);
  assert.equal(selected,result.bankId);
  assert.equal(imported.entries.length,914);
  assert.ok(imported.entries.every(entry=>entry.bankId===result.bankId&&entry.uploadStatus==='uploaded_manual'));
  assert.notEqual(result.bankId,document.source_bank.bank_id);
});

test('shared bank JSON rejects modified payloads before creating a local library', async () => {
  const source = await readFile(new URL('../miniprogram/miniprogram/services/share.ts', import.meta.url), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}});
  const local={version:1,banks:[],batches:[],entries:[]};
  const exports={};
  vm.runInNewContext(outputText,{exports,wx:{},Date,JSON,Array,Set,Error,Math,Number,String,Object,RegExp,
    require:name=>name.endsWith('/bank')?{loadBank:async()=>{},invalidateBank:()=>{},selectBank:()=>{}}
      :name.endsWith('/intake-store')?{readLocal:async()=>local,updateLocal:async change=>change(local),createIds:async()=>()=>id(3)}:intakeCore}, {filename:'services/share.ts'});
  const file={format:'qbank-bank-json-1',source_bank:{bank_id:manifest.bank_id,name:manifest.name},exported_at:new Date().toISOString(),question_count:1,questions:[questions[0]],sha256:'0'.repeat(64)};
  await assert.rejects(()=>exports.importSharedBankJson(JSON.stringify(file)),/校验失败/);
  assert.equal(local.banks.length,0);
  function id(n){return `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`}
});

test('share page has separate homepage and JSON actions and automatically imports a selected chat file', async () => {
  let chosen,importedText='',redirected='',sharedFile='';let resolveRedirect;
  const redirectedPromise=new Promise(resolve=>{resolveRedirect=resolve});
  const page=await loadPage('pages/share/share.ts',{
    chooseMessageFile:options=>{chosen=options;options.success({tempFiles:[{path:'/chat/shared-bank.json'}]})},
    getFileSystemManager:()=>({readFile:options=>options.success({data:'valid-bank-json'})}),
    shareFileMessage:options=>{sharedFile=options.fileName;options.success?.()},
    redirectTo:options=>{redirected=options.url;resolveRedirect()},
  },core,{
    bank:{loadBank:async()=>({bank:bank(),manifest})},
    share:{importSharedBankJson:async text=>{importedText=text;return {bankId:'imported-copy-id'};},exportBankJson:async()=>({filePath:'/user/share.json',fileName:'share.json',questionCount:914})},
  });
  await page.onLoad({bank:manifest.bank_id});
  assert.equal(page.onShareAppMessage().path,'/pages/index/index');
  assert.equal(page.onShareTimeline().query,'');
  assert.equal(page.data.questionCount,914);
  const markup=await readFile(new URL('pages/share/share.wxml',base),'utf8');
  assert.match(markup,/分享主页/);
  assert.match(markup,/仅分享 JSON/);
  assert.match(markup,/用题库打开并自动导入/);
  await page.onShareJson();
  assert.equal(sharedFile,'share.json');
  assert.match(page.data.notice,/914 道题/);
  page.onImportJson();
  await redirectedPromise;
  assert.equal(chosen.extension[0],'json');
  assert.equal(importedText,'valid-bank-json');
  assert.equal(redirected,'/pages/index/index?bank=imported-copy-id');
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

test('Android opens question details with and without a search and renders matching list rows', async () => {
  const android = androidSearchCore();
  for (const query of ['', '天']) {
    const page = await loadPage('pages/detail/detail.ts', {}, android);
    page.getOpenerEventChannel = () => ({on: (_, handler) => handler({query})});
    const id = (await bank().search(query))[0], q = questions[id];
    await page.onLoad({row: String(id), id: q.question_id});
    assert.equal(page.data.error, '');
    assert.equal(page.data.loading, false);
    assert.equal(page.data.stem.map(s => s.text).join(''), q.stem);
    assert.deepEqual(page.data.options.map(o => o.segments.map(s => s.text).join('')), q.options.map(o => o.content));
    assert.equal(page.data.answer, core.answerText(q));
    if (query) assert.ok([...page.data.stem, ...page.data.options.flatMap(o => o.segments),
      ...page.data.metadata.flatMap(m => m.segments)].some(s => s.color >= 0));
    page.onUnload();
  }
  const page = await loadPage('pages/index/index.ts', {}, android);
  await page.onLoad();
  await page.runSearch('天');
  assert.equal(page.data.error, '');
  assert.ok(page.data.rows.length > 0);
  page.onUnload();
});


test('a failed selected-bank download does not hide newly discovered cloud banks',async()=>{
 const advanced='c86104f7-4570-4089-9338-7989ce528a9d';let fresh=false,selected=manifest.bank_id;
 const page=await loadPage('pages/index/index.ts',{},core,{
  bank:{loadBank:async()=>({bank:bank(),manifest}),listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},...(fresh?[{id:advanced,name:'高级题库'}]:[])],activeBankId:()=>selected,selectBank:id=>selected=id},
  sync:{cloudCatalog:()=>fresh?[{bank_id:manifest.bank_id},{bank_id:advanced}]:[],refreshCatalog:async()=>{fresh=true;},syncBank:async()=>{throw Error('下载暂不可用')}},
 });
 page.layout=new core.VirtualList(0);await page.initialize();await page.syncCloud();
 assert.equal(page.data.banks.length,2);assert.equal(page.data.banks[1].id,advanced);assert.match(page.data.syncNotice,/下载/);assert.equal(page.data.total,914);
});
test('a cloud bank without a cache is downloaded before it becomes searchable, and page returns do not resync',async()=>{
 const advanced='c86104f7-4570-4089-9338-7989ce528a9d';let selected=advanced,cached=false,downloads=0,invalidations=0,refreshes=0;
 const page=await loadPage('pages/index/index.ts',{},core,{
  bank:{loadBank:async()=>{if(!cached)throw Error('尚未下载');return {bank:bank(),manifest:{...manifest,bank_id:advanced}}},listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},{id:advanced,name:'高级题库'}],activeBankId:()=>selected,selectBank:id=>selected=id,invalidateBank:()=>invalidations++},
  sync:{cloudCatalog:()=>[{bank_id:advanced}],refreshCatalog:async()=>refreshes++,syncBank:async()=>{downloads++;cached=true;return true;}},
 });
 page.layout=new core.VirtualList(0);await page.initialize();assert.equal(page.data.bankId,advanced);assert.equal(page.data.ready,false);assert.match(page.data.error,/尚未下载/);
 await page.syncCloud();assert.equal(page.data.ready,true);assert.equal(page.data.total,914);assert.equal(invalidations,1);
 page.foregroundSeen=1;page.onShow();page.onShow();assert.equal(downloads,1);assert.equal(refreshes,1);
});

test('home caches the advanced bank automatically without switching and continues after a selected-bank failure',async()=>{
 const advanced='c86104f7-4570-4089-9338-7989ce528a9d',downloaded=[],invalidated=[];
 const page=await loadPage('pages/index/index.ts',{},core,{
  bank:{loadBank:async()=>({bank:bank(),manifest}),listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},{id:advanced,name:'高级题库'}],
    activeBankId:()=>manifest.bank_id,selectBank:()=>{},invalidateBank:id=>invalidated.push(id)},
  sync:{cloudCatalog:()=>[{bank_id:advanced,name:'高级题库'},{bank_id:manifest.bank_id,name:'初级题库'}],refreshCatalog:async()=>{},
    syncBank:async id=>{downloaded.push(id);if(id===manifest.bank_id)throw Error('初级下载暂不可用');return true;}},
 });
 page.layout=new core.VirtualList(0);await page.initialize();await page.syncCloud();
 assert.deepEqual(downloaded,[manifest.bank_id,advanced]);assert.deepEqual(invalidated,[advanced]);
 assert.equal(page.data.bankId,manifest.bank_id);assert.equal(page.data.ready,true);assert.equal(page.data.syncing,false);
 assert.match(page.data.syncNotice,/1 个题库同步未完成/);
});

test('maintainer application button shows validation, progress and persistent errors without a phone authorization popup',async()=>{
 let configured=false,submits=0,emitter,resolve;
 class Controller{constructor(emit){emitter=emit;}async open(){}dispose(){}async flush(){}render(){emitter({records:[],error:''})}}
 const messages=[];
 const page=await loadPage('pages/intake/intake.ts',{showToast:o=>messages.push(o.title)},core,{
  controller:{IntakeController:Controller},
  cloud:{cloud:{state:()=>({configured,loggedIn:false}),applyMaintainer:async(_id,form)=>{submits++;assert.equal(form.realName,'张三');await new Promise(r=>resolve=r);throw Error('测试网络中断');}}},
  sync:{refreshCatalog:async()=>[{bank_id:manifest.bank_id}]},
 });
 page.onLoad();await new Promise(r=>setTimeout(r,0));
 await page.onApplyMaintainer();assert.match(page.data.applicationMessage,/手机号/);assert.equal(submits,0);assert.equal(page.data.applying,false);
 page.setData({maintainerPhone:'13812345678',maintainerRealName:'张三',maintainerIdentity:'课程助教'});
 await page.onApplyMaintainer();assert.match(page.data.applicationMessage,/HTTPS/);assert.equal(submits,0);
 configured=true;const pending=page.onApplyMaintainer();await new Promise(r=>setTimeout(r,0));
 assert.equal(page.data.applying,true);assert.match(page.data.applicationMessage,/登录微信/);await page.onApplyMaintainer();assert.equal(submits,1);
 resolve();await pending;assert.equal(page.data.applying,false);assert.match(page.data.applicationMessage,/网络中断/);
 emitter({records:[],error:''});assert.match(page.data.applicationMessage,/网络中断/);assert.equal(messages.length,3);
 const markup=await readFile(new URL('pages/intake/intake.wxml',base),'utf8');assert.ok(!markup.includes('getPhoneNumber'));assert.match(markup,/真实姓名（必填）/);assert.match(markup,/昵称（选填）/);
 page.onUnload();
});
