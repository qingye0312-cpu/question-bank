import {readDraftFile} from './draft-repository';
import {resultName,sha256} from '../core/intake';
import {LocalBank, SearchIndex, buildPostingsFromLines} from '../core/search';
import {decodeCompactBundle, decodeUtf8} from '../core/compact';
import { bundledManifest, bundledManifests as generatedBundledManifests } from '../data/manifest';
import {readLocal,updateLocal,createIds} from './intake-store';
import {cachedSnapshot,cloudCatalog,restoreCatalog} from './sync';
import {combineLayers,type SyncQuestion} from '../core/sync';

export type Manifest = {
  schema_version: string; bank_id: string; name: string; release_id: string;
  release_version: number; question_count: number; merged_at?:string|null;release_name?:string|null;
};
export type BankBundle = {bank: LocalBank; manifest: Manifest};
// name is the reader-facing title; release_name retains the complete version label.
export type BankSummary = {id: string; name: string; release_name: string};
const bundledManifests: Manifest[] = (generatedBundledManifests || [bundledManifest]) as Manifest[];
const bundledById = new Map(bundledManifests.map(manifest => [manifest.bank_id, manifest]));
let pending: Promise<Map<string, BankBundle>> | undefined;
export const startupMetrics = {source: '', readMs: 0, indexMs: 0, saveMs: 0, totalMs: 0, cacheSaved: false};

function readText(path: string): Promise<string> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: path, encoding: 'utf8', success: result => resolve(result.data as string),
    fail: error => reject(new Error(error.errMsg)),
  }));
}

// Accidental corruption detection, not a publishing/security signature.
function checksum(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function embeddedCachePath(manifest: Manifest): string {
  const suffix = manifest.bank_id === bundledManifests[0].bank_id ? '' : `-${manifest.bank_id}`;
  return `${wx.env.USER_DATA_PATH}/qbank-runtime-index-v1${suffix}.json`;
}

async function loadEmbedded(): Promise<Map<string, BankBundle>> {
  const started = Date.now();
  const compressed = new Promise<string>((resolve, reject) => {
    const fs = wx.getFileSystemManager() as WechatMiniprogram.FileSystemManager & {
      readCompressedFile?: (options: {filePath: string; compressionAlgorithm: 'br';
        success: (result: {data: ArrayBuffer}) => void; fail: (error: {errMsg: string}) => void}) => void;
    };
    if (!fs.readCompressedFile) return reject(new Error('当前微信版本不支持压缩题库，请升级微信'));
    fs.readCompressedFile({filePath: 'data/compact.br', compressionAlgorithm: 'br',
      success: result => { try { resolve(decodeUtf8(result.data)); } catch (e) { reject(e); } },
      fail: error => reject(new Error('压缩题库读取失败：' + error.errMsg))});
  });
  const bundle = JSON.parse(await compressed) as Parameters<typeof decodeCompactBundle>[0];
  if (bundledManifests.some(manifest => manifest.schema_version !== '1.0' || !/^[a-f0-9]{64}$/.test(manifest.release_id))) {
    throw new Error('内置题库资源格式无效，请重新编译');
  }
  const linesById = decodeCompactBundle(bundle, bundledManifests);
  startupMetrics.readMs = Date.now() - started;
  startupMetrics.indexMs = 0;
  startupMetrics.saveMs = 0;
  startupMetrics.cacheSaved = false;
  const result = new Map<string, BankBundle>();
  for (const manifest of bundledManifests) {
    const lines = linesById.get(manifest.bank_id);
    if (!lines || lines.length !== manifest.question_count) throw new Error(`${manifest.name} 内置题库数量不一致，请重新编译`);
    const indexStarted = Date.now(), cache = embeddedCachePath(manifest);
    let index: SearchIndex | undefined;
    startupMetrics.cacheSaved = false;
    try {
      const wrapper = JSON.parse(await readText(cache)) as {payload: string; checksum: number};
      if (typeof wrapper.payload !== 'string' || checksum(wrapper.payload) !== wrapper.checksum) throw new Error('cache checksum');
      const value = JSON.parse(wrapper.payload) as SearchIndex;
      if (value.schema_version !== 'qbank-index-1' || value.release_id !== manifest.release_id
          || value.question_count !== lines.length || !value.postings || typeof value.postings !== 'object'
          || !Object.values(value.postings).every(p => typeof p === 'string' && /^[0-9a-z]+(?:\.[0-9a-z]+)*$/.test(p))) throw new Error('stale cache');
      index = value;
      startupMetrics.source = 'cache';
      startupMetrics.cacheSaved = true;
    } catch { /* Missing, corrupt, or previous release: rebuild from bundled questions. */ }
    if (!index) {
      index = {schema_version: 'qbank-index-1', release_id: manifest.release_id,
        question_count: lines.length, postings: await buildPostingsFromLines(lines)};
      startupMetrics.source = 'generated';
    }
    startupMetrics.indexMs += Date.now() - indexStarted;
    const saveStarted = Date.now();
    if (!startupMetrics.cacheSaved) {
      try {
        const payload = JSON.stringify(index);
        const fs = wx.getFileSystemManager();
        await new Promise<void>((resolve, reject) => fs.writeFile({filePath: cache + '.tmp',
          data: JSON.stringify({payload, checksum: checksum(payload)}), encoding: 'utf8',
          success: () => resolve(), fail: reject}));
        await new Promise<void>((resolve, reject) => fs.rename({oldPath: cache + '.tmp', newPath: cache,
          success: () => resolve(), fail: reject}));
        startupMetrics.cacheSaved = true;
      } catch { console.warn('[qbank] 索引缓存写入失败，本次仍可搜索，下次启动会重新生成'); }
    }
    startupMetrics.saveMs += Date.now() - saveStarted;
    result.set(manifest.bank_id, {manifest, bank: new LocalBank(lines, index)});
  }
  startupMetrics.totalMs = Date.now() - started;
  console.info('[qbank startup]', JSON.stringify(startupMetrics));
  return result;
}

const ACTIVE_BANK_KEY='qbank-active-bank-v1';
let selected='';
let catalogReady:Promise<void>|undefined;
const banks=new Map<string,Promise<BankBundle>>();
export function activeBankId():string {
  if(!selected){try{selected=wx.getStorageSync(ACTIVE_BANK_KEY)||''}catch{/* Keep the bundled bank available. */}}
  return selected||bundledManifests[0].bank_id;
}
export function selectBank(id:string):void {selected=id;try{wx.setStorageSync(ACTIVE_BANK_KEY,id)}catch{/* Current session still switches. */}}
export async function listBanks():Promise<BankSummary[]> {
  if(!catalogReady)catalogReady=restoreCatalog();await catalogReady;
  const local=await readLocal(),all=[...bundledManifests.map(manifest => ({id:manifest.bank_id,name:manifest.name})),...local.banks,...cloudCatalog().map(b=>({id:b.bank_id,name:b.name}))];
  return Promise.all([...new Map(all.map(b=>[b.id,b])).values()].map(async b=>{
    const embeddedManifest=bundledById.get(b.id),snapshot=embeddedManifest?null:await cachedSnapshot(b.id),m=snapshot?.manifest;
    const own=local.banks.find(v=>v.id===b.id);
    const version=m?.release_version??embeddedManifest?.release_version??1,digest=embeddedManifest?.release_id??sha256(b.id);
    return {...b,release_name:embeddedManifest?.release_name||m?.release_name||own?.release_name||resultName(null,b.name,'历史迁移','v'+version,b.id,digest)};
  }));
}
export function invalidateBank(id:string):void {banks.delete(id);}
export async function createBank(name:string):Promise<string>{
  name=name.trim();if(!name||Array.from(name).length>100)throw new Error('题库名称须为 1 至 100 字');
  const id=(await createIds(1))();
  await updateLocal(data=>{data.banks.push({id,name,createdAt:new Date().toISOString(),release_name:resultName(new Date().toISOString(),name,'初建','v1',id,sha256(''))})});selectBank(id);return id;
}
export function loadBank(id=activeBankId()):Promise<BankBundle>{
  const cached=banks.get(id);if(cached){banks.delete(id);banks.set(id,cached);return cached;}
  const result=(async()=>{
    const local=await readLocal();let bundle:BankBundle;
    if(bundledById.has(id)){
      if(!pending)pending=loadEmbedded().catch(error=>{pending=undefined;throw error});
      const embedded=(await pending).get(id);if(!embedded)throw new Error('内置题库不存在，请重新编译');
      bundle={...embedded,bank:embedded.bank.fork()};
    }else{
      const info=local.banks.find(b=>b.id===id)||cloudCatalog().map(b=>({id:b.bank_id,name:b.name})).find(b=>b.id===id);if(!info)throw new Error('题库不存在，请切换其他题库');
      bundle={manifest:{schema_version:'1.0',bank_id:id,name:info.name,release_id:'local',release_version:1,question_count:0},
        bank:new LocalBank([],{schema_version:'qbank-index-1',release_id:'local',question_count:0,postings:Object.create(null)})};
    }
    const cached=await cachedSnapshot(id);
    if(!cached&& !bundledById.has(id)&&cloudCatalog().some(b=>b.bank_id===id)&&!local.banks.some(b=>b.id===id))
      throw new Error('此云端题库尚未下载，联网后点击上方同步提示重试');
    if(cached?.snapshot.formal && !bundledById.has(id)){
      const lines=cached.snapshot.formal.map(q=>JSON.stringify({...q,cloud_layer:'formal'}));
      bundle={manifest:{schema_version:'1.0',bank_id:id,name:cached.manifest.name,merged_at:cached.manifest.merged_at,release_name:cached.manifest.release_name,release_id:cached.manifest.sha256,release_version:cached.manifest.release_version,question_count:lines.length},
        bank:new LocalBank(lines,{schema_version:'qbank-index-1',release_id:cached.manifest.sha256,question_count:lines.length,postings:await buildPostingsFromLines(lines)})};
    }
    const formal=Array.from({length:bundle.bank.count},(_,i)=>bundle.bank.question(i)) as unknown as SyncQuestion[];
    const drafts=await readDraftFile(id),ids=new Set(drafts.map(r=>r.id));
    const working=[...local.entries.filter(e=>e.bankId===id&&!ids.has(e.question.question_id)).map(e=>e.question),...drafts.filter(r=>!r.removed&&!r.issues.length&&r.question).map(r=>r.question!)];
    const merged=combineLayers(formal,working);
    bundle.bank.append(merged.filter(q=>q.cloud_layer!=='formal') as unknown as import('../core/search').Question[]);

    return {bank:bundle.bank,manifest:{...bundle.manifest,question_count:bundle.bank.count}};
  })().catch(error=>{banks.delete(id);throw error});
  banks.set(id,result);while(banks.size>3){const first=banks.keys().next().value!;banks.delete(first);}return result;
}
