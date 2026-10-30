import {authOrigin} from '../config/cloud';
import {readManifest,readSnapshot,snapshotPath,type CloudManifest,type CloudSnapshot} from '../core/sync';
import {buildPostings} from '../core/search';
import {sha256} from '../core/intake';
import {foregroundGeneration} from './foreground';
const inflight=new Map<string,Promise<boolean>>();
let catalog:CloudManifest[]=[];
let catalogRequest:Promise<CloudManifest[]>|undefined,restoring:Promise<void>|undefined,catalogGeneration=-1,catalogOrigin='';
export function cloudCatalog(){return catalog;}
const path=(id:string)=>`${wx.env.USER_DATA_PATH}/qbank-cloud-${id}.json`;
const read=(filePath:string)=>new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath,encoding:'utf8',success:r=>resolve(r.data as string),fail:reject}));
function remove(filePath:string):Promise<void>{
 return new Promise(resolve=>wx.getFileSystemManager().unlink({filePath,success:()=>resolve(),fail:()=>resolve()}));
}
function copy(from:string,to:string):Promise<void>{
 return new Promise((resolve,reject)=>wx.getFileSystemManager().copyFile({srcPath:from,destPath:to,success:()=>resolve(),fail:reject}));
}
async function checked(file:string){const wrapper=JSON.parse(await read(file));if(typeof wrapper.payload!=='string'||sha256(wrapper.payload)!==wrapper.sha256)throw Error('云缓存校验失败');return JSON.parse(wrapper.payload);}
async function recovered(file:string){
 let lastError:unknown;
 for(const candidate of [file,`${file}.bak`,`${file}.tmp`]){
  try{return await checked(candidate);}catch(error){lastError=error;}
 }
 throw lastError instanceof Error?lastError:Error('云缓存不可用');
}
async function write(filePath:string,value:unknown){
 const fs=wx.getFileSystemManager(),payload=JSON.stringify(value),data=JSON.stringify({payload,sha256:sha256(payload)}),temporary=`${filePath}.tmp`,backup=`${filePath}.bak`;
 await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:temporary,data,encoding:'utf8',success:()=>resolve(),fail:reject}));
 await checked(temporary);
 try{await new Promise<void>((resolve,reject)=>fs.rename({oldPath:temporary,newPath:filePath,success:()=>resolve(),fail:reject}));}
 catch{
  // Some WeChat file-system versions do not replace an existing destination
  // with rename. Keep a verified backup while switching files.
  await remove(backup);
  await copy(filePath,backup);
  await remove(filePath);
  try{await new Promise<void>((resolve,reject)=>fs.rename({oldPath:temporary,newPath:filePath,success:()=>resolve(),fail:reject}));}
  catch(error){
   await remove(filePath);
   try{await new Promise<void>((resolve,reject)=>fs.rename({oldPath:backup,newPath:filePath,success:()=>resolve(),fail:reject}));}catch{/* recovered() can still read the backup. */}
   throw error;
  }
 }
 await checked(filePath);
 await remove(backup);
}
export async function cachedSnapshot(id:string):Promise<{manifest:CloudManifest;snapshot:CloudSnapshot}|null>{
 try{const c=await recovered(path(id)),manifest=readManifest(c.manifest);if(manifest.bank_id!==id)throw Error('题库身份错误');return {manifest,snapshot:readSnapshot(c.wrapper,manifest)};}catch{return null;}
}
function requestFailureMessage(message:string):string {
 if(/url not in domain|不在.*合法域名|domain list/i.test(message))return '微信 request 合法域名校验未通过，暂用已缓存题库';
 if(/ssl|tls|certificate|证书|err_connection_reset/i.test(message))return '云端 HTTPS 连接失败，继续使用已缓存题库';
 if(/timeout|timed out|超时/i.test(message))return '云端请求超时，继续使用已缓存题库';
 return '无法连接云端，请检查网络或服务状态；已有缓存仍可使用';
}
function request(endpoint:string):Promise<unknown>{
 const origin=authOrigin();if(!origin)return Promise.reject(Error('云端同步尚未配置'));
 return new Promise((resolve,reject)=>wx.request({url:origin+endpoint,method:'GET',timeout:30000,dataType:'json',responseType:'text',success:r=>{
  if(r.statusCode!==200){reject(Error('云端暂不可用，继续使用已缓存题库'));return;}
  try{const text=typeof r.data==='string'?r.data:JSON.stringify(r.data);if(text.length>8388608)throw Error('响应过大');resolve(JSON.parse(text));}catch{reject(Error('云端返回无效数据'));}
 },fail:error=>reject(Error(requestFailureMessage(error.errMsg||'')))}));
}
export function restoreCatalog():Promise<void>{
 if(!restoring)restoring=(async()=>{
  let stored:CloudManifest[]=[];
  try{stored=(await recovered(`${wx.env.USER_DATA_PATH}/qbank-cloud-catalog.json`)).map(readManifest);}catch{/* A missing catalog is normal on first launch. */}
  const cached:CloudManifest[]=[];
  try{
   const names=await new Promise<string[]>((resolve,reject)=>wx.getFileSystemManager().readdir({dirPath:wx.env.USER_DATA_PATH,success:r=>resolve(r.files),fail:reject}));
   for(const name of names){const match=/^qbank-cloud-([0-9a-f-]{36})\.json(?:\.(?:bak|tmp))?$/.exec(name);if(!match)continue;
    try{const value=await recovered(path(match[1])),manifest=readManifest(value.manifest);if(manifest.bank_id===match[1])cached.push(manifest);}catch{/* Ignore one damaged bank without hiding the others. */}}
  }catch{/* Older clients and first launch may not have a readable cache directory. */}
  catalog=[...new Map([...stored,...cached].map(manifest=>[manifest.bank_id,manifest])).values()];
 })();
 return restoring;
}
export function refreshCatalog(force=false):Promise<CloudManifest[]>{
 if(catalogRequest)return catalogRequest;
 const generation=foregroundGeneration(),origin=authOrigin();
 if(!force&&catalogGeneration===generation&&catalogOrigin===origin)return Promise.resolve(catalog);
 const task=(async()=>{
  // Finish disk restoration first, so a slow restore cannot overwrite a fresh directory.
  await restoreCatalog();
  const response=await request('/v1/catalog') as {banks:unknown[]};
  if(!Array.isArray(response.banks)||response.banks.length>100)throw Error('云端目录无效');const next=response.banks.map(readManifest);
  if(new Set(next.map(m=>m.bank_id)).size!==next.length)throw Error('云端目录含重复题库');
  await write(`${wx.env.USER_DATA_PATH}/qbank-cloud-catalog.json`,next);
  catalog=next;catalogGeneration=generation;catalogOrigin=origin;return catalog;
 })();catalogRequest=task;void task.finally(()=>{if(catalogRequest===task)catalogRequest=undefined;}).catch(()=>{});return task;
}
export function syncBank(id:string,advertised?:CloudManifest):Promise<boolean>{
 if(inflight.has(id))return inflight.get(id)!;
 const task=(async()=>{
  const manifest=readManifest(advertised||await request(`/v1/banks/${id}/manifest`));if(manifest.bank_id!==id)throw Error('题库身份不符');
  const previous=await cachedSnapshot(id);
  // Compare the revision and digest. A rollback or server-side restore can
  // replace a snapshot while retaining the same revision, so revision alone
  // must not leave a stale local bank in place.
  if(previous&&manifest.revision===previous.manifest.revision&&manifest.sha256===previous.manifest.sha256)return false;
  // Revision zero is the catalog placeholder for a bank with no formal snapshot.
  if(manifest.revision===0)return false;
  const wrapper=await request(snapshotPath(manifest)),snapshot=readSnapshot(wrapper,manifest);
  if(manifest.question_count!=null&&(snapshot.formal?.length||0)!==manifest.question_count)throw Error('云端题库数量与版本清单不一致，保留本地题库');
  // A concurrent server update produces a mismatch: retry on the next sync,
  // never install content from a different revision than the checked manifest.
  if(snapshot.revision===0)return false;
  buildPostings((snapshot.formal||[]) as unknown as import('../core/search').Question[]);
  await write(path(id),{manifest,wrapper});return true;
 })();inflight.set(id,task);void task.finally(()=>inflight.delete(id)).catch(()=>{});return task;
}
