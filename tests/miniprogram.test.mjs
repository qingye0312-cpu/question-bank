import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as intakeCore from '../desktop/shared/intake.ts';
import * as answerPresentationCore from '../desktop/shared/answer-presentation.ts';
import * as core from '../miniprogram/miniprogram/core/search.ts';
import {prepareCloudOnly} from '../tools/mobile-index/build.mjs';
import {normalize as desktopNormalize, queryTerms as desktopTerms} from '../desktop/src/search-presentation.ts';

const base = new URL('../miniprogram/miniprogram/', import.meta.url);
function loadServiceModule(relative){
 const cache=new Map();
 function load(name,parent){
  let url=new URL(name,parent);
  if(!url.pathname.endsWith('.ts')&&!url.pathname.endsWith('.js')){
   const tsUrl=new URL(`${name}.ts`,parent),jsUrl=new URL(`${name}.js`,parent);
   url=existsSync(tsUrl)?tsUrl:jsUrl;
  }
  if(cache.has(url.href))return cache.get(url.href);
  const source=readFileSync(url,'utf8'),module={exports:{}},exports=module.exports;
  cache.set(url.href,exports);
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(compiled,{exports,module,require:child=>load(child,url),console,Error,Map,Set,Array,Object,String,Number,Boolean,RegExp,JSON,Math,Date},{filename:url.pathname});
  return module.exports;
 }
 return load(relative,base);
}
const {applicationFields,passwordMeetsPolicy,registrationFields}=loadServiceModule('services/maintainer-application.ts');
const payload = await readFile(new URL('../tools/mobile-index/sources/basic/questions.jsonl', import.meta.url), 'utf8');
const lines = payload.trimEnd().split('\n'), questions = lines.map(line => JSON.parse(line));
const index = {schema_version:'qbank-index-1',release_id:'source-basic',question_count:questions.length,postings:core.buildPostings(questions)};
const manifest = {schema_version:'1.0',bank_id:'ad50971f-66af-51c2-bb0e-dc798b03b369',name:'HarmonyOS 初级认证',release_id:'a'.repeat(64),release_version:9,question_count:questions.length,release_name:'云端初级认证 v9'};
const cloudUpdatedAt='2026-10-29T04:16:20.176Z';
const cloudManifest={bank_id:manifest.bank_id,name:manifest.name,revision:19,release_version:9,question_count:questions.length,sha256:'b'.repeat(64),bytes:0,minimum_client:'0.2.7',updated_at:cloudUpdatedAt,snapshot_format:'qbank-cloud-file-1',protocol:3};
const cloudSnapshot={format:'qbank-snapshot-2',bank_id:manifest.bank_id,name:manifest.name,revision:19,release_version:9,updated_at:cloudUpdatedAt,formal:questions,pending:[],removed:[]};
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

test('Mini Program package is cloud-only and does not carry generated question data', async () => {
  assert.equal(questions.length, 984);
  assert.equal(manifest.bank_id, 'ad50971f-66af-51c2-bb0e-dc798b03b369');
  const checked = await prepareCloudOnly({check: true});
  assert.equal(checked.mode, 'cloud-only');
  assert.equal(existsSync(new URL('data/compact.br', base)), false);
  const config = JSON.parse(await readFile(new URL('../miniprogram/project.config.json', import.meta.url), 'utf8'));
  assert.ok(config.packOptions.ignore.some(item => item.type === 'folder' && item.value === 'data'));
});

async function loadService(readResource, extra = {}) {
  const source = await readFile(new URL('services/bank.ts', base), 'utf8');
  const {outputText} = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}});
  const exports = {};
  const intake = await import('../desktop/shared/intake.ts');
  const sync = await import('../desktop/shared/sync.ts');
  const syncService=extra.sync||{cachedSnapshot:async id=>id===manifest.bank_id?{manifest:cloudManifest,snapshot:cloudSnapshot}:null,cloudCatalog:()=>[cloudManifest],restoreCatalog:async()=>{}};
  const localState=extra.local||{version:1,banks:[],entries:[],batches:[]};
  const draftRecords=extra.drafts||[];
  vm.runInNewContext(outputText, {exports, require: name => name==='./draft-repository'?{readDraftFile:async()=>draftRecords}:name==='./sync'?syncService:name.endsWith('/core/sync')||name==='../core/sync'?sync:name.endsWith('/intake-store') ? {readLocal:async()=>localState} : name.endsWith('/intake') ? intake : core,
    wx: {env: {USER_DATA_PATH: '/cache'},getStorageSync:()=>'',setStorageSync:()=>{}}, console: {error() {}, info() {}, warn() {}}, Error});
  return exports;
}

test('bank loader reads the cloud snapshot cache and never opens package data', async () => {
  const service = await loadService(() => { throw new Error('package data must not be read'); });
  const first = service.loadBank(manifest.bank_id), concurrent = service.loadBank(manifest.bank_id);
  assert.equal(first, concurrent);
  const loaded = await first;
  assert.equal(loaded.manifest.release_id, cloudManifest.sha256);
  assert.equal(loaded.bank.question(983).question_id, questions[983].question_id);
  assert.deepEqual(await loaded.bank.search('用户 聊天'), await bank().search('用户 聊天'));
  assert.equal(await service.loadBank(manifest.bank_id), loaded);
});

test('bank loader rejects an uncached cloud bank until sync has written a snapshot', async () => {
  const service = await loadService(() => { throw new Error('package data must not be read'); }, {sync:{cachedSnapshot:async()=>null,cloudCatalog:()=>[cloudManifest],restoreCatalog:async()=>{}}});
  await assert.rejects(service.loadBank(manifest.bank_id), /尚未下载/);
});

test('uploaded drafts that disappeared after a cloud rollback stay out of the local question layer', async () => {
  const uploadedId='00000000-0000-4000-8000-000000000123';
  const pendingId='00000000-0000-4000-8000-000000000124';
  const uploaded=fixture({question_id:uploadedId,stem:'已经上传但被云端回退的题目'});
  const pending=fixture({question_id:pendingId,stem:'仍然等待上传的本地新题'});
  const local={version:1,banks:[],batches:[],entries:[{bankId:manifest.bank_id,batchId:'00000000-0000-4000-8000-000000000456',question:uploaded,createdAt:'2026-10-31T00:00:00Z',uploadStatus:'uploaded',exportedAt:'',sharedAt:''},{bankId:manifest.bank_id,batchId:'00000000-0000-4000-8000-000000000457',question:pending,createdAt:'2026-10-31T00:00:01Z',uploadStatus:'pending',exportedAt:'',sharedAt:''}]};
  const drafts=[{id:uploadedId,bankId:manifest.bank_id,revision:2,submissionId:'00000000-0000-4000-8000-000000000456',removed:false,issues:[],question:uploaded},{id:pendingId,bankId:manifest.bank_id,revision:1,submissionId:'00000000-0000-4000-8000-000000000457',removed:false,issues:[],question:pending}];
  const service=await loadService(()=>{throw new Error('package data must not be read');},{local,drafts});
  const loaded=await service.loadBank(manifest.bank_id);
  assert.equal(loaded.bank.count,questions.length+1);
  assert.equal(loaded.manifest.local_question_count,1);
  assert.deepEqual(await loaded.bank.search('已经上传但被云端回退'),[]);
  assert.equal((await loaded.bank.search('仍然等待上传')).length,1);
});

test('shared questions marked uploaded_manual remain visible in their local bank', async () => {
  const localBankId='00000000-0000-4000-8000-000000000125';
  const shared=fixture({question_id:'00000000-0000-4000-8000-000000000126',stem:'共享导入的本地题目'});
  const local={version:1,banks:[{id:localBankId,name:'共享题库'}],batches:[],entries:[{bankId:localBankId,batchId:'00000000-0000-4000-8000-000000000127',question:shared,createdAt:'2026-10-31T00:00:00Z',uploadStatus:'uploaded_manual',exportedAt:'',sharedAt:''}]};
  const service=await loadService(()=>{throw new Error('package data must not be read');},{local,sync:{cachedSnapshot:async()=>null,cloudCatalog:()=>[],restoreCatalog:async()=>{}}});
  const loaded=await service.loadBank(localBankId);
  assert.equal(loaded.manifest.release_id,'local');
  assert.equal(loaded.bank.count,1);
  assert.equal((await loaded.bank.search('共享导入')).length,1);
});

test('runtime index matches build-time index exactly', async () => {
  assert.deepEqual(await core.buildPostingsFromLines(lines), Object.assign(Object.create(null), index.postings));
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
  const layout = new core.VirtualList(984);
  const heights = questions.map((_, i) => 90 + i % 6 * 31);
  layout.measure(0, heights);
  const seen = new Set();
  for (let i = 0; i < 984; i++) {
    const range = layout.window(layout.offset(i), 720);
    assert.ok(range.start <= i && range.end > i);
    assert.ok(range.end - range.start < 30);
    assert.equal(range.before + heights.slice(range.start, range.end).reduce((a, b) => a + b, 0) + range.after, layout.offset(984));
    for (let n = range.start; n < range.end; n++) seen.add(n);
  }
  assert.equal(seen.size, 984);
  assert.equal(layout.window(0, 720).start, 0);
  assert.equal(layout.window(layout.offset(984) - 720, 720).end, 984);
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
      : name.endsWith('/maintainer-application') ? {applicationFields,passwordMeetsPolicy,registrationFields}
      : name.endsWith('/intake-controller') ? services.controller
      : name.endsWith('/cloud') ? services.cloud
      : name.endsWith('/search') ? searchCore
      : name.endsWith('/intake') ? intakeCore
      : name.endsWith('/answer-presentation') ? answerPresentationCore
      : name.endsWith('/bank') ? (services.bank||{loadBank: async () => ({bank: bank(), manifest}),listBanks:async()=>[{id:manifest.bank_id,name:manifest.name}],activeBankId:()=>manifest.bank_id,selectBank:()=>{},bankCacheGeneration:()=>0})
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
  assert.equal(page.data.total, 984);
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
  assert.equal(page.data.count, 984);
  page.onUnload();
});

test('home page share callbacks open the same public bank and restore its search query', async () => {
  const sharedBankId='public-bank-id';let selectedBank='',catalogLoaded=false,refreshCalls=0;
  const page = await loadPage('pages/index/index.ts', {}, core, {
    bank:{loadBank:async id=>({bank:bank(),manifest:{...manifest,bank_id:id,name:id===sharedBankId?'共享题库':manifest.name}}),
      listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},...(catalogLoaded?[{id:sharedBankId,name:'共享题库'}]:[])],
      activeBankId:()=>manifest.bank_id,selectBank:id=>{selectedBank=id;},bankCacheGeneration:()=>0},
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
      activeBankId:()=>privateBankId,selectBank:()=>{},bankCacheGeneration:()=>0},
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
  assert.equal(document.question_count,984);
  assert.equal(document.questions[0].bank,'共享源题库');
  const result=await exports.importSharedBankJson(files.get(output.filePath));
  assert.equal(result.name,'共享源题库（分享副本）');
  assert.equal(result.added,984);
  assert.equal(selected,result.bankId);
  assert.equal(imported.entries.length,984);
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
    share:{importSharedBankJson:async text=>{importedText=text;return {bankId:'imported-copy-id'};},exportBankJson:async()=>({filePath:'/user/share.json',fileName:'share.json',questionCount:984})},
  });
  await page.onLoad({bank:manifest.bank_id});
  assert.equal(page.onShareAppMessage().path,'/pages/index/index');
  assert.equal(page.onShareTimeline().query,'');
  assert.equal(page.data.questionCount,984);
  const markup=await readFile(new URL('pages/share/share.wxml',base),'utf8');
  assert.match(markup,/分享主页/);
  assert.match(markup,/仅分享 JSON/);
  assert.match(markup,/用题库打开并自动导入/);
  await page.onShareJson();
  assert.equal(sharedFile,'share.json');
  assert.match(page.data.notice,/984 道题/);
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
  bank:{loadBank:async()=>({bank:bank(),manifest}),listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},...(fresh?[{id:advanced,name:'高级题库'}]:[])],activeBankId:()=>selected,selectBank:id=>selected=id,bankCacheGeneration:()=>0},
  sync:{cloudCatalog:()=>fresh?[{bank_id:manifest.bank_id},{bank_id:advanced}]:[],refreshCatalog:async()=>{fresh=true;},syncBank:async()=>{throw Error('下载暂不可用')}},
 });
 page.layout=new core.VirtualList(0);await page.initialize();await page.syncCloud();
 assert.equal(page.data.banks.length,2);assert.equal(page.data.banks[1].id,advanced);assert.match(page.data.syncNotice,/下载/);assert.equal(page.data.total,984);
});
test('a cloud bank without a cache is downloaded before it becomes searchable, and page returns do not resync',async()=>{
 const advanced='c86104f7-4570-4089-9338-7989ce528a9d';let selected=advanced,cached=false,downloads=0,invalidations=0,refreshes=0;
 const page=await loadPage('pages/index/index.ts',{},core,{
  bank:{loadBank:async()=>{if(!cached)throw Error('尚未下载');return {bank:bank(),manifest:{...manifest,bank_id:advanced}}},listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},{id:advanced,name:'高级题库'}],activeBankId:()=>selected,selectBank:id=>selected=id,invalidateBank:()=>invalidations++,bankCacheGeneration:()=>0},
  sync:{cloudCatalog:()=>[{bank_id:advanced}],refreshCatalog:async()=>refreshes++,syncBank:async()=>{downloads++;cached=true;return true;}},
 });
 page.layout=new core.VirtualList(0);await page.initialize();assert.equal(page.data.bankId,advanced);assert.equal(page.data.ready,false);assert.match(page.data.error,/尚未下载/);
 await page.syncCloud();assert.equal(page.data.ready,true);assert.equal(page.data.total,984);assert.equal(invalidations,1);
 page.foregroundSeen=1;page.onShow();page.onShow();assert.equal(downloads,1);assert.equal(refreshes,1);
});
test('returning from intake reloads a changed local cache and refreshes the cloud catalogue',async()=>{
 let cacheGeneration=0,loads=0;const refreshModes=[];
 const page=await loadPage('pages/index/index.ts',{},core,{
  bank:{loadBank:async()=>{loads++;return {bank:bank(),manifest}},listBanks:async()=>[{id:manifest.bank_id,name:manifest.name}],
    activeBankId:()=>manifest.bank_id,selectBank:()=>{},bankCacheGeneration:()=>cacheGeneration},
  sync:{cloudCatalog:()=>[],refreshCatalog:async force=>{refreshModes.push(force);return []},syncBank:async()=>false},
 });
 page.layout=new core.VirtualList(0);await page.onLoad();await new Promise(resolve=>setTimeout(resolve,0));
 cacheGeneration=1;page.onShow();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(loads,2);
 assert.ok(refreshModes.includes(true));
 assert.equal(page.cacheGenerationSeen,1);
});
test('first cloud-only launch selects and opens the first downloaded cloud bank',async()=>{
 const cloudBank='c86104f7-4570-4089-9338-7989ce528a9d';let discovered=false,cached=false,selected='';
 const page=await loadPage('pages/index/index.ts',{},core,{
  bank:{loadBank:async()=>{if(!cached)throw Error('尚未下载');return {bank:bank(),manifest:{...manifest,bank_id:cloudBank,name:'高级题库'}}},
    listBanks:async()=>discovered?[{id:cloudBank,name:'高级题库'}]:[],activeBankId:()=>selected,selectBank:id=>selected=id,invalidateBank:()=>{},bankCacheGeneration:()=>0},
  sync:{cloudCatalog:()=>discovered?[{bank_id:cloudBank,name:'高级题库'}]:[],refreshCatalog:async()=>{discovered=true;},syncBank:async()=>{cached=true;return true}},
 });
 page.layout=new core.VirtualList(0);await page.initialize();assert.equal(page.data.ready,false);assert.equal(page.data.bankId,'');
 await page.syncCloud();
 assert.equal(page.data.bankId,cloudBank);assert.equal(selected,cloudBank);assert.equal(page.data.ready,true);assert.equal(page.data.total,984);
});

test('home caches the advanced bank automatically without switching and continues after a selected-bank failure',async()=>{
 const advanced='c86104f7-4570-4089-9338-7989ce528a9d',downloaded=[],invalidated=[];
 const page=await loadPage('pages/index/index.ts',{},core,{
  bank:{loadBank:async()=>({bank:bank(),manifest}),listBanks:async()=>[{id:manifest.bank_id,name:manifest.name},{id:advanced,name:'高级题库'}],
    activeBankId:()=>manifest.bank_id,selectBank:()=>{},invalidateBank:id=>invalidated.push(id),bankCacheGeneration:()=>0},
  sync:{cloudCatalog:()=>[{bank_id:advanced,name:'高级题库'},{bank_id:manifest.bank_id,name:'初级题库'}],refreshCatalog:async()=>{},
    syncBank:async id=>{downloaded.push(id);if(id===manifest.bank_id)throw Error('初级下载暂不可用');return true;}},
 });
 page.layout=new core.VirtualList(0);await page.initialize();await page.syncCloud();
 assert.deepEqual(downloaded,[manifest.bank_id,advanced]);assert.deepEqual(invalidated,[advanced]);
 assert.equal(page.data.bankId,manifest.bank_id);assert.equal(page.data.ready,true);assert.equal(page.data.syncing,false);
 assert.match(page.data.syncNotice,/1 个题库同步未完成/);
});

test('maintainer registration validates required information, shows progress and preserves errors without a phone authorization popup',async()=>{
 let configured=false,submits=0,emitter,resolve;
 class Controller{constructor(emit){emitter=emit;}async open(){}dispose(){}async flush(){}render(){emitter({records:[],error:''})}}
 const messages=[];
 const page=await loadPage('pages/intake/intake.ts',{showToast:o=>messages.push(o.title)},core,{
  controller:{IntakeController:Controller},
  cloud:{cloud:{state:()=>({configured,loggedIn:false}),registerMaintainer:async(_id,form)=>{submits++;assert.equal(form.realName,'张三');await new Promise(r=>resolve=r);throw Error('测试网络中断');}}},
  sync:{refreshCatalog:async()=>[{bank_id:manifest.bank_id}]},
 });
 page.onLoad();await new Promise(r=>setTimeout(r,0));
 page.setData({maintainerPassword:'StrongPass123',maintainerPasswordConfirm:'StrongPass123'});
 await page.onRegisterMaintainer();assert.match(page.data.applicationMessage,/手机号/);assert.equal(submits,0);assert.equal(page.data.applying,false);
 page.setData({maintainerPhone:'13812345678',maintainerRealName:'张三',maintainerNickname:'star',maintainerIdentity:'课程助教',maintainerPassword:'StrongPass123',maintainerPasswordConfirm:'StrongPass123'});
 await page.onRegisterMaintainer();assert.match(page.data.applicationMessage,/HTTPS/);assert.equal(submits,0);
 configured=true;page.setData({maintainerPassword:'StrongPass123',maintainerPasswordConfirm:'StrongPass123'});const pending=page.onRegisterMaintainer();await new Promise(r=>setTimeout(r,0));
 assert.equal(page.data.applying,true);assert.match(page.data.applicationMessage,/正在创建账号/);await page.onRegisterMaintainer();assert.equal(submits,1);
 resolve();await pending;assert.equal(page.data.applying,false);assert.match(page.data.applicationMessage,/网络中断/);
 emitter({records:[],error:''});assert.match(page.data.applicationMessage,/网络中断/);assert.equal(messages.length,3);
 const markup=await readFile(new URL('pages/intake/intake.wxml',base),'utf8');assert.ok(!markup.includes('getPhoneNumber'));assert.match(markup,/真实姓名（必填）/);assert.match(markup,/昵称（必填，用于记录上传者）/);
 page.onUnload();
});

test('intake export button shares a prepared file directly from the tap handler',async()=>{
 let shared=0;
 const page=await loadPage('pages/intake/intake.ts',{shareFileMessage:options=>{shared++;options.success?.()}},core,{controller:{IntakeController:class{}}});
 page.setData({pendingCount:1,filePath:'/user/export.json',fileName:'export.json',exportPrepared:true});
 page.onExport();
 assert.equal(shared,1);
 assert.match(page.data.notice,/已打开聊天分享面板/);
 const markup=await readFile(new URL('pages/intake/intake.wxml',base),'utf8');
 assert.ok(!markup.includes('转发导出 JSON'));
});
