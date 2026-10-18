import {invoke} from '@tauri-apps/api/core';
import {failedJob,readyJob,UploadError,type UploadJob} from '../../shared/queue';
import {cloudOrigin,cloudCall,cloudAccess,resumeDesktop,sessionGeneration,setLogoutHandler,type Access} from './session-service';
import {syncDesktop} from './sync-service';
export async function uploadDesktop(batchId:string,bankId:string,confirmed=true){
 const origin=cloudOrigin(),attempt=sessionGeneration();
 const check=()=>{if(origin!==cloudOrigin()||attempt!==sessionGeneration())throw Error("服务地址或登录已改变，请重试原批次");};
 const me=await cloudCall<Access>('/v1/me',undefined,true);if(!me.grants[bankId]?.includes('upload'))throw new UploadError('没有当前题库的上传权限',403);
 if(!me.uploads_enabled)throw new UploadError('云端尚未启用上传',503);
 check();
 const transfer=await invoke<{envelope:unknown;receipt:unknown}>('cloud_transfer',{batchId,endpoint:origin});
 check();
 const accepted=await cloudCall<{receipt:unknown;duplicate:boolean}>('/v1/uploads',confirmed?{format:'qbank-confirmed-upload-1',package:transfer.envelope}:transfer.envelope,true);
 try{await invoke('cloud_receipt',{batchId,receipt:accepted.receipt});}catch{throw new UploadError('云端已接收，本地回执未保存；将使用原包找回回执',0,'RECEIPT_SAVE_FAILED');}
 return accepted;
}
let queueWrite:Promise<unknown>=Promise.resolve(),queueRun:Promise<void>|undefined;
export async function desktopJobs():Promise<UploadJob[]>{return await invoke<UploadJob[]|null>('client_state',{key:'upload-queue',value:null})||[];}
function updateJobs(change:(jobs:UploadJob[])=>void|Promise<void>){
 const run=queueWrite.catch(()=>{}).then(async()=>{const jobs=await desktopJobs();await change(jobs);await invoke('client_state',{key:'upload-queue',value:jobs});window.dispatchEvent(new Event('qbank-upload-change'));});queueWrite=run;return run;
}
export async function enqueueDesktop(_batches:string[],bankId:string){
 const records=await invoke<import('../../shared/draft').DraftRecord[]>('draft_records',{bankId});
 return enqueueDrafts(bankId,records.filter(r=>!r.removed&&!r.submissionId).map(r=>({id:r.id,revision:r.revision})));
}
export async function enqueueDrafts(bankId:string,expected:{id:string;revision:number}[]){
 const attempt=sessionGeneration(),origin=cloudOrigin(),me=await cloudCall<Access>('/v1/me',undefined,true);
 if(!me.openid||!me.grants[bankId]?.includes('upload'))throw new UploadError('请先登录有此题库上传权限的维护者',403);
 const health=await cloudCall<{capabilities?:string[]}>('/health');
 if(!health.capabilities?.includes('session-upload-v1'))throw new UploadError('云端需更新后才能提交',409,'UPGRADE_REQUIRED');
 if(attempt!==sessionGeneration()||origin!==cloudOrigin())throw Error('登录或服务地址已改变，未提交');
 // Queue updates and native preparation share this writer, so a background
 // receipt cannot overwrite the transaction that appends a newly confirmed job.
 const task=queueWrite.catch(()=>{}).then(()=>invoke<UploadJob>('draft_submit',{bankId,expected,endpoint:origin,actor:me.openid}));
 queueWrite=task;const job=await task;window.dispatchEvent(new Event('qbank-upload-change'));return job;
}
export function pauseDesktopJobs(){return updateJobs(jobs=>{for(const j of jobs)if(!['done','failed'].includes(j.status)){j.status='paused';j.error='已退出登录，任务保留';}});}
export async function retryDesktopJobs(bankId?:string,includeFailed=false){
 const me=cloudAccess();if(!me)return;
 await updateJobs(jobs=>{for(const j of jobs)if((!bankId||j.bankId===bankId)&&j.status!=='done'&&(includeFailed||j.status!=='failed')&&j.actor===me.openid&&j.endpoint===cloudOrigin()){j.status='queued';j.nextAt=0;j.error='';}});
}
export async function recoverLegacyJobs(bankId:string){
 const origin=cloudOrigin(),me=await cloudCall<Access>('/v1/me',undefined,true);
 if(!me.openid||!me.grants[bankId]?.includes('upload'))throw new UploadError('请使用原上传身份登录',403);
 const task=queueWrite.catch(()=>{}).then(()=>invoke<number>('cloud_recover_legacy',{bankId,endpoint:origin,actor:me.openid}));queueWrite=task;
 const count=await task;window.dispatchEvent(new Event('qbank-upload-change'));return count;
}
export async function syncUploadedBank(bankId:string){
 try{await syncDesktop(bankId);await updateJobs(js=>{for(const j of js)if(j.bankId===bankId&&j.status==='done')j.syncError='';});}
 catch(e){await updateJobs(js=>{for(const j of js)if(j.bankId===bankId&&j.status==='done')j.syncError=String(e);});throw e;}
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
   await uploadDesktop(job.id,job.bankId,job.confirmed!==false);
   await updateJobs(js=>{const j=js.find(j=>j.id===job.id)!;j.status='done';j.error='';});
   await syncUploadedBank(job.bankId).catch(()=>{});
  }catch(e){await updateJobs(js=>{const i=js.findIndex(j=>j.id===job.id);if(i>=0&&!['done','paused'].includes(js[i].status))js[i]=failedJob(js[i],e);});}
 }})();queueRun=run;void run.finally(()=>{queueRun=undefined;}).catch(()=>{});return run;
}

setLogoutHandler(()=>void pauseDesktopJobs().catch(()=>{}));
