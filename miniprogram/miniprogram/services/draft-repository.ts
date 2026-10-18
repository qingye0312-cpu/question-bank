import {sha256} from '../core/intake';
import type {DraftRecord} from '../core/draft';
const cache=new Map<string,Promise<DraftRecord[]>>();
let writer:Promise<unknown>=Promise.resolve();
export function withDraftLock<T>(work:()=>Promise<T>):Promise<T>{const task=writer.catch(()=>{}).then(work);writer=task;return task;}
function file(bank:string){if(!/^[a-f0-9-]{36}$/.test(bank))throw Error('题库标识无效');return `${wx.env.USER_DATA_PATH}/qbank-drafts-${bank}.json`;}
export async function readDraftFile(bank:string):Promise<DraftRecord[]>{
 if(!cache.has(bank))cache.set(bank,new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file(bank),encoding:'utf8',success:r=>resolve(r.data as string),fail:reject})).then(text=>{
  const w=JSON.parse(text);if(typeof w.payload!=='string'||sha256(w.payload)!==w.sha256)throw Error('录题草稿校验失败，请保留本机数据');
  const records=JSON.parse(w.payload);if(!Array.isArray(records)||records.some(r=>r.bankId!==bank||typeof r.id!=='string'||!Number.isSafeInteger(r.revision)))throw Error('录题记录格式无效');return records;
 }).catch(e=>{cache.delete(bank);if(/no such|not exist|not found|ENOENT/i.test(e.errMsg||''))return [];throw e instanceof Error?e:Error(e.errMsg||'草稿读取失败');}));
 return cache.get(bank)!;
}
export async function writeDraftFile(bank:string,records:DraftRecord[]){
 const payload=JSON.stringify(records),fs=wx.getFileSystemManager(),path=file(bank);
 await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:path+'.tmp',encoding:'utf8',data:JSON.stringify({payload,sha256:sha256(payload)}),success:()=>resolve(),fail:reject}));
 await new Promise<void>((resolve,reject)=>fs.rename({oldPath:path+'.tmp',newPath:path,success:()=>resolve(),fail:reject}));cache.set(bank,Promise.resolve(records));
}
