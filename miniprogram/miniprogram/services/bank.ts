import {readDraftFile} from './draft-repository';
import {resultName,sha256} from '../core/intake';
import {LocalBank, buildPostingsFromLines} from '../core/search';
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
export const startupMetrics = {source: '', readMs: 0, indexMs: 0, saveMs: 0, totalMs: 0, cacheSaved: false};

const ACTIVE_BANK_KEY='qbank-active-bank-v1';
let selected='';
let catalogReady:Promise<void>|undefined;
const banks=new Map<string,Promise<BankBundle>>();
export function activeBankId():string {
  if(!selected){try{selected=wx.getStorageSync(ACTIVE_BANK_KEY)||''}catch{/* Keep the last in-memory selection. */}}
  return selected||cloudCatalog()[0]?.bank_id||'';
}
export function selectBank(id:string):void {selected=id;try{wx.setStorageSync(ACTIVE_BANK_KEY,id)}catch{/* Current session still switches. */}}
export async function listBanks():Promise<BankSummary[]> {
  if(!catalogReady)catalogReady=restoreCatalog();await catalogReady;
  const local=await readLocal(),all=[...local.banks,...cloudCatalog().map(b=>({id:b.bank_id,name:b.name}))];
  return Promise.all([...new Map(all.map(b=>[b.id,b])).values()].map(async b=>{
    const snapshot=await cachedSnapshot(b.id),m=snapshot?.manifest;
    const own=local.banks.find(v=>v.id===b.id);
    const version=m?.release_version??1,digest=m?.sha256??sha256(b.id);
    return {...b,release_name:m?.release_name||own?.release_name||resultName(null,b.name,'历史迁移','v'+version,b.id,digest)};
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
    const local=await readLocal(),info=local.banks.find(b=>b.id===id)||cloudCatalog().map(b=>({id:b.bank_id,name:b.name})).find(b=>b.id===id);
    if(!info)throw new Error('题库不存在，请先连接云端同步题库');
    let bundle:BankBundle={manifest:{schema_version:'1.0',bank_id:id,name:info.name,release_id:'local',release_version:1,question_count:0},
      bank:new LocalBank([],{schema_version:'qbank-index-1',release_id:'local',question_count:0,postings:Object.create(null)})};
    const cached=await cachedSnapshot(id);
    if(!cached&&cloudCatalog().some(b=>b.bank_id===id)&&!local.banks.some(b=>b.id===id))
      throw new Error('此云端题库尚未下载，联网后点击上方同步提示重试');
    if(cached){
      const lines=(cached.snapshot.formal||[]).map(q=>JSON.stringify({...q,cloud_layer:'formal'}));
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
