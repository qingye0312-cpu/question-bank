/// <reference types="vite/client" />
import {invoke} from '@tauri-apps/api/core';
import {failedJob,readyJob,UploadError,type UploadJob} from '../shared/queue';
import {readManifest,readSnapshot,type CloudManifest} from '../shared/sync';
type Access={openid?:string;banks:{bank_id:string;name:string}[];grants:Record<string,string[]>;uploads_enabled:boolean};
type Session={token:string;origin:string;expires:number;access:Access};
const ORIGIN_KEY='qbank-cloud-origin-v1';
let session:Session|undefined;
let generation=0;
export function cloudOrigin(){return localStorage.getItem(ORIGIN_KEY)||import.meta.env.VITE_QBANK_API_ORIGIN||(import.meta.env.DEV?'https://1324463245-3bbpy3eujf.ap-guangzhou.tencentscf.com':'');}
export function setCloudOrigin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('请填写不带路径的 HTTPS 地址');
 localStorage.setItem(ORIGIN_KEY,u.origin);session=undefined;generation++;}
export function cloudAccess(){if(session&&(session.expires<Date.now()+15000||session.origin!==cloudOrigin()))session=undefined;return session?.access;}
const rememberKey=(origin=cloudOrigin())=>'qbank-remember:'+origin;
export function remembersMachine(){return localStorage.getItem(rememberKey())==='yes';}
let credentialWrite:Promise<unknown>=Promise.resolve();
function storeCredential(origin:string,key:string|null){const task=credentialWrite.catch(()=>{}).then(()=>invoke('credential_save',{origin,key}));credentialWrite=task;return task;}
export async function cloudForget(){const origin=cloudOrigin();localStorage.removeItem(rememberKey(origin));await storeCredential(origin,null);}
export function cloudLogout(){session=undefined;generation++;void pauseDesktopJobs().catch(()=>{});if(remembersMachine())void cloudForget().catch(()=>{});}

export async function cloudCall<T>(path:string,body?:unknown,authenticated=false):Promise<T>{
 const origin=cloudOrigin();if(!origin)throw Error('请先配置云端 HTTPS 服务地址');
 if(authenticated&&!cloudAccess())throw new UploadError('请先进行维护者登录',401,'SIGNED_OUT');
 const current=session;const response=await invoke<{status:number;body:T&{error?:{message?:string;code?:string}}}>('cloud_request',{origin,path,body:body??null,token:authenticated?session!.token:null});
 if(response.status<200||response.status>=300){if((response.status===401||response.status===403)&&session===current)cloudLogout();throw new UploadError(response.body.error?.message||'云端请求未完成，请重试',response.status,response.body.error?.code);}return response.body;
}
async function acceptLogin(result:{access_token:string;expires_in:number},attempt:number,origin:string,started:number){
 if(!/^v1\.[\w-]+\.[\w-]+$/.test(result.access_token)||result.expires_in<1||result.expires_in>900||origin!==cloudOrigin()||attempt!==generation)throw Error('登录响应无效');
 session={token:result.access_token,origin,expires:started+result.expires_in*1000,access:{banks:[],grants:{},uploads_enabled:false}};
 try{const me=await cloudCall<Access>('/v1/me',undefined,true);if(!Array.isArray(me.banks)||!me.grants)throw Error('维护权限响应无效');if(attempt!==generation||!session)throw Error('登录已取消，请重新验证');session.access=me;return me;}catch(e){if(attempt===generation)session=undefined;throw e;}
}
export async function cloudLogin(key:string,remember=false){
 session=undefined;const attempt=++generation,origin=cloudOrigin(),started=Date.now();
 const result=await cloudCall<{access_token:string;expires_in:number}>('/v1/auth/desktop',{key});
 const me=await acceptLogin(result,attempt,origin,started);
 if(remember){await storeCredential(origin,key);if(attempt!==generation||origin!==cloudOrigin()){await storeCredential(origin,null);throw Error('登录已取消，本机凭据已清除');}localStorage.setItem(rememberKey(origin),'yes');}
 else if(remembersMachine())await cloudForget();
 return me;
}
let renewing:Promise<Access|undefined>|undefined;
export function resumeDesktop():Promise<Access|undefined>{
 if(cloudAccess())return Promise.resolve(cloudAccess());if(!remembersMachine())return Promise.resolve(undefined);if(renewing)return renewing;
 const attempt=++generation,origin=cloudOrigin(),started=Date.now();
 const task=(async()=>{const response=await invoke<{status:number;body:{access_token:string;expires_in:number}}>('credential_login',{origin});
  if(response.status!==200){if(response.status===401||response.status===403){if(attempt===generation)cloudLogout();}throw new UploadError('本机凭据无法完成登录，请手动验证',response.status);}
  return acceptLogin(response.body,attempt,origin,started);
 })();renewing=task;void task.finally(()=>{if(renewing===task)renewing=undefined}).catch(()=>{});return task;
}
export async function uploadDesktop(batchId:string,bankId:string,confirmed=true){
 const origin=cloudOrigin(),attempt=generation;
 const check=()=>{if(origin!==cloudOrigin()||attempt!==generation)throw Error("服务地址或登录已改变，请重试原批次");};
 const me=await cloudCall<Access>('/v1/me',undefined,true);if(!me.grants[bankId]?.includes('upload'))throw new UploadError('没有当前题库的上传权限',403);
 if(!me.uploads_enabled)throw new UploadError('云端尚未启用上传',503);
 check();
 const transfer=await invoke<{envelope:unknown;receipt:unknown}>('cloud_transfer',{batchId,endpoint:origin});
 check();
 const accepted=await cloudCall<{receipt:unknown;duplicate:boolean}>('/v1/uploads',confirmed?{format:'qbank-confirmed-upload-1',package:transfer.envelope}:transfer.envelope,true);
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

let queueWrite:Promise<unknown>=Promise.resolve(),queueRun:Promise<void>|undefined;
export async function desktopJobs():Promise<UploadJob[]>{return await invoke<UploadJob[]|null>('client_state',{key:'upload-queue',value:null})||[];}
function updateJobs(change:(jobs:UploadJob[])=>void|Promise<void>){
 const run=queueWrite.catch(()=>{}).then(async()=>{const jobs=await desktopJobs();await change(jobs);await invoke('client_state',{key:'upload-queue',value:jobs});window.dispatchEvent(new Event('qbank-upload-change'));});queueWrite=run;return run;
}
export async function enqueueDesktop(batches:string[],bankId:string){
 const attempt=generation,origin=cloudOrigin(),me=await cloudCall<Access>('/v1/me',undefined,true);
 if(!me.openid||!me.grants[bankId]?.includes('upload'))throw new UploadError('请先登录有此题库上传权限的维护者',403);
 const health=await cloudCall<{capabilities?:string[]}>('/health');if(!health.capabilities?.includes('confirmed-upload-v1'))throw new UploadError('云端需部署支持整批确认的新版本后才能提交',409,'UPGRADE_REQUIRED');
 if(attempt!==generation||origin!==cloudOrigin())throw Error('登录或服务地址已改变，未提交');
 for(const groupId of batches){
  const ids=await invoke<string[]>('intake_prepare',{batchId:groupId});
  // The transfer exists before the job; a failed job write leaves a recoverable
  // frozen local batch and cannot start an unrecorded network request.
  for(const id of ids)await invoke('cloud_transfer',{batchId:id,endpoint:origin});
  await updateJobs(jobs=>{for(const id of ids)if(!jobs.some(j=>j.id===id))jobs.push({id,groupId,bankId,endpoint:origin,actor:me.openid!,confirmedAt:new Date().toISOString(),status:'queued',attempts:0,nextAt:0,error:''});});
 }
}
export function pauseDesktopJobs(){return updateJobs(jobs=>{for(const j of jobs)if(!['done','failed'].includes(j.status)){j.status='paused';j.error='已退出登录，任务保留';}});}
export async function retryDesktopJobs(bankId?:string){
 const me=cloudAccess();if(!me)return;
 await updateJobs(jobs=>{for(const j of jobs)if((!bankId||j.bankId===bankId)&&j.status!=='done'&&j.status!=='failed'&&j.actor===me.openid&&j.endpoint===cloudOrigin()){j.status='queued';j.nextAt=0;j.error='';}});
}
export function runDesktopQueue():Promise<void>{
 if(queueRun)return queueRun;
 const run=(async()=>{for(const job of await desktopJobs()){
  if(!readyJob(job)||!readyJob((await desktopJobs()).find(j=>j.id===job.id)||job))continue;
  try{const me=cloudAccess()||await resumeDesktop();if(!me)throw new UploadError('登录已过期，请重新登录后恢复任务',401);
   if(job.actor!==me.openid||job.endpoint!==cloudOrigin())throw new UploadError('登录身份或云端地址已改变，请使用原身份恢复',403,'IDENTITY_CHANGED');
   const latest=(await desktopJobs()).find(j=>j.id===job.id);if(latest?.status==='paused')continue;
   await updateJobs(js=>{const j=js.find(j=>j.id===job.id)!;if(j.status!=='paused')j.status='uploading';});
   if((await desktopJobs()).find(j=>j.id===job.id)?.status==='paused')continue;
   await uploadDesktop(job.id,job.bankId,true);
   await updateJobs(js=>{const j=js.find(j=>j.id===job.id)!;j.status='done';j.error='';});
   await syncDesktop(job.bankId).catch(()=>{});
  }catch(e){await updateJobs(js=>{const i=js.findIndex(j=>j.id===job.id);if(i>=0&&!['done','paused'].includes(js[i].status))js[i]=failedJob(js[i],e);});}
 }})();queueRun=run;void run.finally(()=>{queueRun=undefined;}).catch(()=>{});return run;
}
export function startCloudWorker(onChanged:()=>void){
 let updating=false,lastSync=0;
 const wake=()=>{void runDesktopQueue().catch(()=>{});if(updating||Date.now()-lastSync<30000)return;updating=true;lastSync=Date.now();void invoke<{id:string}[]>('banks').then(async banks=>{let changed=false;for(const b of banks)try{changed=(await syncDesktop(b.id))||changed;}catch{}if(changed)onChanged();}).catch(()=>{}).finally(()=>{updating=false;});};
 const timer=setInterval(wake,15000);window.addEventListener('online',wake);window.addEventListener('focus',wake);wake();
 return()=>{clearInterval(timer);window.removeEventListener('online',wake);window.removeEventListener('focus',wake)};
}

export type PublishJob={id:string;origin:string;actor:string;path:string;body:Record<string,unknown>;status:'pending'|'done'|'failed';error:string};
export async function publishJobs():Promise<PublishJob[]>{return await invoke<PublishJob[]|null>('client_state',{key:'publish-operations',value:null})||[];}
let publishing=false;
export async function cloudMutation(path:string,body:Record<string,unknown>,retryId?:string){
 if(publishing)throw Error('已有合并操作正在执行');publishing=true;
 try{
  const access=cloudAccess();if(!access?.openid)throw Error('请先登录维护者');
  const jobs=await publishJobs(),origin=cloudOrigin(),actor=access.openid;
  let job=retryId?jobs.find(j=>j.id===retryId):jobs.find(j=>j.status==='pending'&&j.origin===origin&&j.actor===actor&&j.path===path&&JSON.stringify(j.body)===JSON.stringify(body));
  if(retryId&&!job)throw Error('合并任务不存在');
  if(job&&(job.origin!==origin||job.actor!==actor))throw Error('请使用原服务地址和维护者身份重试');
  if(!job){job={id:crypto.randomUUID(),origin,actor,path,body,status:'pending',error:''};jobs.push(job);await invoke('client_state',{key:'publish-operations',value:jobs});}
  const current=job;
  try{const result=await cloudCall(current.path,{...current.body,operation_id:current.id},true);current.status='done';current.error='';await invoke('client_state',{key:'publish-operations',value:jobs.filter(j=>j.status!=='done'||j===current)});return result;}
  catch(e){const status=e instanceof UploadError?e.status:0;current.error=String(e);if(status>=400&&status<500&&![401,403,408,429].includes(status))current.status='failed';await invoke('client_state',{key:'publish-operations',value:jobs});throw e;}
 }finally{publishing=false;}
}
