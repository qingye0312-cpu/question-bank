import {IntakeQuestion, sha256, uuidFromBytes} from '../core/intake';
import type {UploadJob} from '../core/queue';
import type {UploadReceipt} from '../core/upload';
export type LocalEntry={bankId:string;batchId:string;question:IntakeQuestion;createdAt:string;uploadStatus:'pending'|'uploaded_manual'|'uploaded';exportedAt:string;sharedAt:string};
export type LocalBatch={id:string;bankId:string;createdAt:string;sealedText?:string;upload?:{endpoint:string;text:string;receipt?:UploadReceipt}};
export type LocalCatalog={id:string;name:string;createdAt?:string;release_name?:string};
export type IntakeStore={drafts?:Record<string,{current:Record<string,unknown>;previous?:Record<string,unknown>}>;jobs?:UploadJob[];version:1;banks:LocalCatalog[];batches:LocalBatch[];entries:LocalEntry[]};
let cached:Promise<IntakeStore>|undefined;
let writes:Promise<unknown>=Promise.resolve();
const file=()=>`${wx.env.USER_DATA_PATH}/qbank-intake-v1.json`;
export function readLocal():Promise<IntakeStore>{
 if(!cached)cached=new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file(),encoding:'utf8',success:r=>resolve(r.data as string),fail:reject})).then(text=>{
  const wrapper=JSON.parse(text) as {payload:string;sha256:string};
  if(typeof wrapper.payload!=='string'||sha256(wrapper.payload)!==wrapper.sha256)throw new Error('本地新题记录校验失败，请先备份文件，不要清除数据');
  const data=JSON.parse(wrapper.payload) as IntakeStore;
  if(data.version!==1||!Array.isArray(data.banks)||!Array.isArray(data.batches)||!Array.isArray(data.entries))throw new Error('本地新题记录格式无效');
  return data;
 }).catch(error=>{
  if(/no such|not exist|not found|ENOENT/i.test(error.errMsg||''))return {version:1,banks:[],batches:[],entries:[]} as IntakeStore;
  cached=undefined;throw error instanceof Error?error:new Error(error.errMsg||'本地新题读取失败');
 });
 return cached;
}
export function updateLocal<T>(change:(data:IntakeStore)=>T|Promise<T>):Promise<T>{
 const run=writes.then(async()=>{
  const next=JSON.parse(JSON.stringify(await readLocal())) as IntakeStore;
  const result=await change(next),payload=JSON.stringify(next),fs=wx.getFileSystemManager();
  await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:file()+'.tmp',encoding:'utf8',data:JSON.stringify({payload,sha256:sha256(payload)}),success:()=>resolve(),fail:reject}));
  await new Promise<void>((resolve,reject)=>fs.rename({oldPath:file()+'.tmp',newPath:file(),success:()=>resolve(),fail:reject}));
  cached=Promise.resolve(next);return result;
 });
 writes=run.catch(()=>{});return run;
}
export async function createIds(count:number):Promise<()=>string>{
 const data=await new Promise<ArrayBuffer>((resolve,reject)=>wx.getRandomValues({length:count*16,success:r=>resolve(r.randomValues),fail:reject}));
 let offset=0;return()=>{const bytes=new Uint8Array(data).slice(offset,offset+16);offset+=16;return uuidFromBytes(bytes)};
}
