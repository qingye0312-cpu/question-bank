/// <reference types="vite/client" />
import {invoke} from '@tauri-apps/api/core';
import {readManifest,readSnapshot,type CloudManifest} from '../shared/sync';
type Access={banks:{bank_id:string;name:string}[];grants:Record<string,string[]>;uploads_enabled:boolean};
type Session={token:string;origin:string;expires:number;access:Access};
const ORIGIN_KEY='qbank-cloud-origin-v1';
let session:Session|undefined;
let generation=0;
export function cloudOrigin(){return localStorage.getItem(ORIGIN_KEY)||import.meta.env.VITE_QBANK_API_ORIGIN||(import.meta.env.DEV?'https://1324463245-3bbpy3eujf.ap-guangzhou.tencentscf.com':'');}
export function setCloudOrigin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('请填写不带路径的 HTTPS 地址');
 localStorage.setItem(ORIGIN_KEY,u.origin);session=undefined;generation++;}
export function cloudAccess(){if(session&&(session.expires<Date.now()+15000||session.origin!==cloudOrigin()))session=undefined;return session?.access;}
export function cloudLogout(){session=undefined;generation++;}
export async function cloudCall<T>(path:string,body?:unknown,authenticated=false):Promise<T>{
 const origin=cloudOrigin();if(!origin)throw Error('请先配置云端 HTTPS 服务地址');
 if(authenticated&&!cloudAccess())throw Error('请先进行维护者登录');
 const current=session;const response=await invoke<{status:number;body:T&{error?:{message?:string}}}>('cloud_request',{origin,path,body:body??null,token:authenticated?session!.token:null});
 if(response.status<200||response.status>=300){if((response.status===401||response.status===403)&&session===current)cloudLogout();throw Error(response.body.error?.message||'云端请求未完成，请重试');}return response.body;
}
export async function cloudLogin(key:string){
 session=undefined;const attempt=++generation;const started=Date.now(),origin=cloudOrigin();
 const result=await cloudCall<{access_token:string;expires_in:number}>('/v1/auth/desktop',{key});
 if(!/^v1\.[\w-]+\.[\w-]+$/.test(result.access_token)||result.expires_in<1||result.expires_in>900||origin!==cloudOrigin()||attempt!==generation)throw Error('登录响应无效');
 session={token:result.access_token,origin,expires:started+result.expires_in*1000,access:{banks:[],grants:{},uploads_enabled:false}};
 try{const me=await cloudCall<Access>('/v1/me',undefined,true);if(!Array.isArray(me.banks)||!me.grants)throw Error('维护权限响应无效');if(attempt!==generation||!session)throw Error('登录已取消，请重新验证');session.access=me;return me;}catch(e){if(attempt===generation)session=undefined;throw e;}
}
export async function uploadDesktop(batchId:string,bankId:string){
 const origin=cloudOrigin(),attempt=generation;
 const check=()=>{if(origin!==cloudOrigin()||attempt!==generation)throw Error("服务地址或登录已改变，请重试原批次");};
 const me=await cloudCall<Access>('/v1/me',undefined,true);if(!me.grants[bankId]?.includes('upload'))throw Error('没有当前题库的上传权限');
 if(!me.uploads_enabled)throw Error('云端尚未启用上传');
 check();
 const transfer=await invoke<{envelope:unknown;receipt:unknown}>('cloud_transfer',{batchId,endpoint:origin});
 check();
 const accepted=await cloudCall<{receipt:unknown;duplicate:boolean}>('/v1/uploads',transfer.envelope,true);
 try{await invoke('cloud_receipt',{batchId,receipt:accepted.receipt});}catch{throw Error('云端已接收，本地回执未保存；请重试同一批次，不要重新录入');}
 return accepted;
}
export async function fetchCatalog():Promise<CloudManifest[]>{
 const result=await cloudCall<{banks:unknown[]}>('/v1/catalog');if(!Array.isArray(result.banks)||result.banks.length>100)throw Error('云端目录无效');return result.banks.map(readManifest);
}
const syncing=new Map<string,Promise<boolean>>();
export function syncDesktop(bankId:string):Promise<boolean>{
 const origin=cloudOrigin(),key=`${origin}/${bankId}`;
 if(syncing.has(key))return syncing.get(key)!;
 const checkOrigin=()=>{if(origin!==cloudOrigin())throw Error('服务地址已改变，本次同步已取消，原题库仍保留');};
 const task=(async()=>{
  const m=readManifest(await cloudCall(`/v1/banks/${bankId}/manifest`));if(m.bank_id!==bankId)throw Error('题库身份不一致');
  checkOrigin();
  const versions=await invoke<{bank_id:string;revision:number;sha256:string}[]>('cloud_versions'),old=versions.find(v=>v.bank_id===bankId);
  checkOrigin();
  if(old){if(old.revision>m.revision)throw Error('拒绝云端版本倒退');if(old.revision===m.revision){if(old.sha256!==m.sha256)throw Error('同版本内容发生变化');return false;}}
  if(m.revision===0)return false;
  const wrapper=await cloudCall<{payload:string;sha256:string}>(`/v1/banks/${bankId}/snapshot`);readSnapshot(wrapper,m);
  checkOrigin();
  await invoke('cloud_apply',wrapper);return true;
 })();syncing.set(key,task);void task.finally(()=>syncing.delete(key)).catch(()=>{});return task;
}
