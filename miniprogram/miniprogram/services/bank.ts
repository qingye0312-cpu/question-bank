import {LocalBank, SearchIndex, buildPostingsFromLines} from '../core/search';
import {CompactBank, decodeCompact, decodeUtf8} from '../core/compact';
import { bundledManifest } from '../data/manifest';
import {readLocal,updateLocal,createIds} from './intake-store';
import {identityKey} from '../core/intake';
import type {Question} from '../core/search';

export type Manifest = {
  schema_version: string; bank_id: string; name: string; release_id: string;
  release_version: number; question_count: number;
};
export type BankBundle = {bank: LocalBank; manifest: Manifest};
let pending: Promise<BankBundle> | undefined;
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

async function loadEmbedded(): Promise<BankBundle> {
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
  const questionText = await compressed;
  const manifest: Manifest = bundledManifest;
  if (manifest.schema_version !== '1.0' || !/^[a-f0-9]{64}$/.test(manifest.release_id)) {
    throw new Error('内置题库资源格式无效，请重新编译');
  }
  const lines = decodeCompact(JSON.parse(questionText) as CompactBank, manifest.release_id, manifest.question_count);
  if (lines.length !== manifest.question_count) throw new Error('内置题库数量不一致，请重新编译');
  startupMetrics.readMs = Date.now() - started;
  const indexStarted = Date.now();
  const cache = `${wx.env.USER_DATA_PATH}/qbank-runtime-index-v1.json`;
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
  startupMetrics.indexMs = Date.now() - indexStarted;
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
  startupMetrics.saveMs = Date.now() - saveStarted;
  startupMetrics.totalMs = Date.now() - started;
  console.info('[qbank startup]', JSON.stringify(startupMetrics));
  return {manifest, bank: new LocalBank(lines, index)};
}

const ACTIVE_BANK_KEY='qbank-active-bank-v1';
let selected='';
const banks=new Map<string,Promise<BankBundle>>();
export function activeBankId():string {
  if(!selected){try{selected=wx.getStorageSync(ACTIVE_BANK_KEY)||''}catch{/* Keep the bundled bank available. */}}
  return selected||bundledManifest.bank_id;
}
export function selectBank(id:string):void {selected=id;try{wx.setStorageSync(ACTIVE_BANK_KEY,id)}catch{/* Current session still switches. */}}
export async function listBanks():Promise<{id:string;name:string}[]> {
  const local=await readLocal();
  return [{id:bundledManifest.bank_id,name:bundledManifest.name},...local.banks.filter(b=>b.id!==bundledManifest.bank_id)];
}
export function invalidateBank(id:string):void {banks.delete(id);}
export async function createBank(name:string):Promise<string>{
  name=name.trim();if(!name||Array.from(name).length>100)throw new Error('题库名称须为 1 至 100 字');
  const id=(await createIds(1))();
  await updateLocal(data=>{data.banks.push({id,name})});selectBank(id);return id;
}
export function loadBank(id=activeBankId()):Promise<BankBundle>{
  const cached=banks.get(id);if(cached)return cached;
  const result=(async()=>{
    const local=await readLocal();let bundle:BankBundle;
    if(id===bundledManifest.bank_id){
      if(!pending)pending=loadEmbedded().catch(error=>{pending=undefined;throw error});
      bundle=await pending;
    }else{
      const info=local.banks.find(b=>b.id===id);if(!info)throw new Error('题库不存在，请切换其他题库');
      bundle={manifest:{schema_version:'1.0',bank_id:id,name:info.name,release_id:'local',release_version:1,question_count:0},
        bank:new LocalBank([],{schema_version:'qbank-index-1',release_id:'local',question_count:0,postings:Object.create(null)})};
    }
    const identities=new Set<string>(),ids=new Set<string>();
    for(let row=0;row<bundle.bank.count;row++){const q=bundle.bank.question(row);identities.add(identityKey(q));ids.add(q.question_id);}
    const additions:Question[]=[];
    for(const e of local.entries.filter(e=>e.bankId===id)){
      const key=identityKey(e.question);if(identities.has(key)||ids.has(e.question.question_id))continue;
      identities.add(key);ids.add(e.question.question_id);additions.push(e.question);
    }
    bundle.bank.append(additions);
    return {bank:bundle.bank,manifest:{...bundle.manifest,question_count:bundle.bank.count}};
  })().catch(error=>{banks.delete(id);throw error});
  banks.set(id,result);return result;
}
