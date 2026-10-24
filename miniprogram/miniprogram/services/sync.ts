import {authOrigin} from '../config/cloud';
import {readManifest,readSnapshot,snapshotPath,type CloudManifest,type CloudSnapshot} from '../core/sync';
import {buildPostings} from '../core/search';
import {sha256} from '../core/intake';
const inflight=new Map<string,Promise<boolean>>();
let catalog:CloudManifest[]=[];
export function cloudCatalog(){return catalog;}
const path=(id:string)=>`${wx.env.USER_DATA_PATH}/qbank-cloud-${id}.json`;
const read=(filePath:string)=>new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath,encoding:'utf8',success:r=>resolve(r.data as string),fail:reject}));
async function write(filePath:string,value:unknown){const fs=wx.getFileSystemManager(),payload=JSON.stringify(value),data=JSON.stringify({payload,sha256:sha256(payload)});
 await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:filePath+'.tmp',data,encoding:'utf8',success:()=>resolve(),fail:reject}));
 await new Promise<void>((resolve,reject)=>fs.rename({oldPath:filePath+'.tmp',newPath:filePath,success:()=>resolve(),fail:reject}));
}
async function checked(file:string){const wrapper=JSON.parse(await read(file));if(typeof wrapper.payload!=='string'||sha256(wrapper.payload)!==wrapper.sha256)throw Error('云缓存校验失败');return JSON.parse(wrapper.payload);}
export async function cachedSnapshot(id:string):Promise<{manifest:CloudManifest;snapshot:CloudSnapshot}|null>{
 try{const c=await checked(path(id)),manifest=readManifest(c.manifest);if(manifest.bank_id!==id)throw Error('题库身份错误');return {manifest,snapshot:readSnapshot(c.wrapper,manifest)};}catch{return null;}
}
function request(endpoint:string):Promise<unknown>{
 const origin=authOrigin();if(!origin)return Promise.reject(Error('云端同步尚未配置'));
 return new Promise((resolve,reject)=>wx.request({url:origin+endpoint,method:'GET',timeout:15000,dataType:'json',responseType:'text',success:r=>{
  if(r.statusCode!==200){reject(Error('云端暂不可用，继续使用本地题库'));return;}
  try{const text=typeof r.data==='string'?r.data:JSON.stringify(r.data);if(text.length>8388608)throw Error('响应过大');resolve(JSON.parse(text));}catch{reject(Error('云端返回无效数据'));}
 },fail:()=>reject(Error('网络不可用，继续使用本地题库'))}));
}
export async function restoreCatalog(){try{catalog=(await checked(`${wx.env.USER_DATA_PATH}/qbank-cloud-catalog.json`)).map(readManifest);}catch{/* Bundled and local banks remain available. */}}
export async function refreshCatalog(){const response=await request('/v1/catalog') as {banks:unknown[]};
 if(!Array.isArray(response.banks)||response.banks.length>100)throw Error('云端目录无效');const next=response.banks.map(readManifest);
 if(new Set(next.map(m=>m.bank_id)).size!==next.length)throw Error('云端目录含重复题库');
 await write(`${wx.env.USER_DATA_PATH}/qbank-cloud-catalog.json`,next);catalog=next;return catalog;
}
export function syncBank(id:string):Promise<boolean>{
 if(inflight.has(id))return inflight.get(id)!;
 const task=(async()=>{
  const manifest=readManifest(await request(`/v1/banks/${id}/manifest`));if(manifest.bank_id!==id)throw Error('题库身份不符');
  const previous=await cachedSnapshot(id);
  if(previous){if(manifest.revision<previous.manifest.revision)throw Error('云端版本倒退，旧版仍然保留');
   if(manifest.revision===previous.manifest.revision){if(manifest.sha256!==previous.manifest.sha256)throw Error('相同版本内容发生变化');return false;}}
  const wrapper=await request(snapshotPath(manifest)),snapshot=readSnapshot(wrapper,manifest);
  // A concurrent server update produces a mismatch: retry on the next sync,
  // never install formal and pending snapshots from different revisions.
  if(snapshot.revision===0)return false;
  buildPostings([...((snapshot.formal||[]).concat(snapshot.pending))] as unknown as import('../core/search').Question[]);
  await write(path(id),{manifest,wrapper});return true;
 })();inflight.set(id,task);void task.finally(()=>inflight.delete(id)).catch(()=>{});return task;
}
