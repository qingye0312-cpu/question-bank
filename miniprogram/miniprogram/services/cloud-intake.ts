import {deltaPackage} from '../core/intake';
import {prepareUpload,verifyReceipt} from '../core/upload';
import {cloud} from './cloud';
import {loadBank} from './bank';
import {readLocal,updateLocal} from './intake-store';

const uploading=new Set<string>();
export async function uploadBatch(bankId:string,batchId:string,confirmed=false,actor?:string){
  if(uploading.has(batchId))throw new Error('本批次正在上传，请稍候');
  uploading.add(batchId);
  try{
    const batch=(await readLocal()).batches.find(b=>b.id===batchId&&b.bankId===bankId);
    if(!batch)throw new Error('请选择当前题库的录入批次');
    const {manifest}=await loadBank(bankId);
    const endpoint=await cloud.authorize(bankId,manifest.name);
    if(actor&&cloud.state().openid!==actor)throw new UploadError("登录身份已改变",403,"IDENTITY_CHANGED");
    const snapshot=await updateLocal(data=>{
      const current=data.batches.find(b=>b.id===batchId&&b.bankId===bankId);
      if(!current)throw new Error('录入批次已改变，请重新选择');
      if(current.upload){
        if(current.upload.endpoint!==endpoint)throw new Error('此批次使用的云端地址已改变，请联系维护者确认后迁移');
        return current.upload;
      }
      const questions=data.entries.filter(e=>e.bankId===bankId&&e.batchId===batchId).map(e=>e.question);
      const text=current.sealedText||deltaPackage(bankId,manifest.name,batchId,questions,current.createdAt);
      prepareUpload(text); // Reject oversized/invalid data before reserving this batch.
      current.upload={endpoint,text};return current.upload;
    });
    const prepared=prepareUpload(snapshot.text);
    if(prepared.delta.bank_id!==bankId||prepared.delta.batch_id!==batchId)throw new Error('本地上传批次身份不一致，请先备份并联系维护者');
    if(snapshot.receipt)return {receipt:verifyReceipt(snapshot.receipt,prepared),duplicate:true};
    if(actor){const job=(await readLocal()).jobs?.find(j=>j.id===batchId);if(job?.status==='paused'||cloud.state().openid!==actor)throw new UploadError("任务已暂停",401,"SIGNED_OUT");}
    const result=await cloud.upload(prepared,endpoint,confirmed),receipt=verifyReceipt(result.receipt,prepared);
    try{
      await updateLocal(data=>{
        const current=data.batches.find(b=>b.id===batchId&&b.bankId===bankId);
        if(!current?.upload||current.upload.text!==snapshot.text||current.upload.endpoint!==endpoint)throw new Error('本地批次已改变');
        const entries=data.entries.filter(e=>e.bankId===bankId&&e.batchId===batchId);
        if(JSON.stringify(entries.map(e=>e.question))!==JSON.stringify(prepared.questions))throw new Error('本地题目已改变');
        current.upload.receipt=receipt;
        for(const entry of entries)entry.uploadStatus='uploaded';
      });
    }catch{throw new UploadError('云端已接收，将使用原包找回回执',0,'RECEIPT_SAVE_FAILED');}
    return {...result,receipt};
  }finally{uploading.delete(batchId);}
}

import {failedJob,readyJob,UploadError} from '../core/queue';
import {syncBank} from './sync';
import {invalidateBank} from './bank';
let running:Promise<void>|undefined;
// Compatibility entry point: all pending records now form one session request.
export async function enqueueBatches(bankId:string,_batchIds:string[]){
 const {listDrafts,submitDrafts}=await import('./drafts');
 const records=(await listDrafts(bankId)).filter(r=>!r.removed&&!r.submissionId);
 return submitDrafts(bankId,records.map(r=>({id:r.id,revision:r.revision})));
}
export async function recoverLegacyUploads(bankId:string){
 const {manifest}=await loadBank(bankId),endpoint=await cloud.authorize(bankId,manifest.name),actor=cloud.state().openid;
 if(!actor)throw Error('请使用原上传身份登录');
 await updateLocal(data=>{data.jobs=data.jobs||[];for(const b of data.batches){
  if(b.bankId!==bankId||!b.upload||b.upload.endpoint!==endpoint||data.jobs.some(j=>j.id===b.id))continue;
  prepareUpload(b.upload.text);
  data.jobs.push({id:b.id,groupId:b.id,bankId,endpoint,actor,confirmedAt:b.createdAt,confirmed:false,status:b.upload.receipt?'done':'queued',attempts:0,nextAt:0,error:''});
 }});
}
export async function pauseUploads(){await updateLocal(data=>{for(const job of data.jobs||[])if(!['done','failed'].includes(job.status)){job.status='paused';job.error='已退出登录，任务保留';}});}
export async function retryUploads(includeFailed=false){const actor=cloud.state().openid;if(!actor)return;await updateLocal(data=>{for(const j of data.jobs||[])if(j.actor===actor&&j.status!=='done'&&(includeFailed||j.status!=='failed')){j.status='queued';j.nextAt=0;j.error='';}});}
export async function syncUploadedBank(bankId:string){
 try{await syncBank(bankId);invalidateBank(bankId);await updateLocal(d=>{for(const j of d.jobs||[])if(j.bankId===bankId&&j.status==='done')j.syncError='';});}
 catch(e){await updateLocal(d=>{for(const j of d.jobs||[])if(j.bankId===bankId&&j.status==='done')j.syncError=String(e);});throw e;}
}
export function runUploadQueue():Promise<void>{
 if(running)return running;
 const task=(async()=>{for(const job of (await readLocal()).jobs||[]){
  if(!readyJob(job)||!readyJob((await readLocal()).jobs?.find(j=>j.id===job.id)||job))continue;
  try{const {manifest}=await loadBank(job.bankId),endpoint=await cloud.authorize(job.bankId,manifest.name);
   if(endpoint!==job.endpoint||cloud.state().openid!==job.actor)throw new UploadError('登录身份或服务地址改变，请使用原身份恢复',403,'IDENTITY_CHANGED');
   const latest=(await readLocal()).jobs?.find(j=>j.id===job.id);if(latest?.status==='paused')continue;
   await updateLocal(d=>{const j=d.jobs!.find(j=>j.id===job.id)!;if(j.status!=='paused')j.status='uploading';});
   if((await readLocal()).jobs?.find(j=>j.id===job.id)?.status==='paused')continue;
   await uploadBatch(job.bankId,job.id,job.confirmed!==false,job.actor);
   await updateLocal(d=>{const j=d.jobs!.find(j=>j.id===job.id)!;j.status='done';j.error='';});
   await syncUploadedBank(job.bankId).catch(()=>{});
  }catch(e){await updateLocal(d=>{const i=d.jobs!.findIndex(j=>j.id===job.id);if(i>=0&&!['done','paused'].includes(d.jobs![i].status))d.jobs![i]=failedJob(d.jobs![i],e);});}
 }})();running=task;void task.finally(()=>{running=undefined}).catch(()=>{});return task;
}
