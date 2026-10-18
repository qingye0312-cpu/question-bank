import {deltaPackage} from '../core/intake';
import {prepareUpload,verifyReceipt} from '../core/upload';
import {cloud} from './cloud';
import {loadBank} from './bank';
import {readLocal,updateLocal,createIds} from './intake-store';

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
    }catch{throw new Error('云端已接收，本地回执保存失败；请重试同一批次以找回回执，不要重新录入');}
    return {...result,receipt};
  }finally{uploading.delete(batchId);}
}

import {failedJob,readyJob,UploadError} from '../core/queue';
import {syncBank} from './sync';
import {invalidateBank} from './bank';
let running:Promise<void>|undefined;
export async function enqueueBatches(bankId:string,batchIds:string[]){
 const {manifest}=await loadBank(bankId),endpoint=await cloud.authorize(bankId,manifest.name),actor=cloud.state().openid;
 if(!actor)throw new UploadError('请先验证开发者身份',401);
 const health=await cloud.health();if(!Array.isArray(health.capabilities)||!health.capabilities.includes('confirmed-upload-v1'))throw new UploadError('云端需部署支持整批确认的新版本',409,'UPGRADE_REQUIRED');
 const ids=await createIds((await readLocal()).entries.length+batchIds.length+1),at=new Date().toISOString();
 await updateLocal(data=>{data.jobs=data.jobs||[];
  for(const groupId of batchIds){
   if(data.jobs.some(j=>j.groupId===groupId))continue;
   const batch=data.batches.find(b=>b.id===groupId&&b.bankId===bankId);if(!batch)throw Error('批次不存在');
   const entries=data.entries.filter(e=>e.batchId===groupId&&e.bankId===bankId);if(!entries.length)continue;
   if(batch.upload?.receipt)continue;
   const chunks:typeof entries[]=[[]];
   for(const e of entries){const current=chunks[chunks.length-1],trial=[...current,e];
    try{prepareUpload(deltaPackage(bankId,manifest.name,groupId,trial.map(e=>e.question),batch.createdAt));current.push(e);}
    catch(error){if(!current.length)throw error;prepareUpload(deltaPackage(bankId,manifest.name,groupId,[e.question],batch.createdAt));chunks.push([e]);}}
   if(chunks.length>1&&batch.upload)throw Error('历史已提交批次不能重新拆分，请找回原回执');
   for(const chunk of chunks){const id=chunks.length>1?ids():groupId;
    let current=data.batches.find(b=>b.id===id);if(!current){current={id,bankId,createdAt:batch.createdAt};data.batches.push(current);}
    const text=current.upload?.text||current.sealedText||deltaPackage(bankId,manifest.name,id,chunk.map(e=>e.question),batch.createdAt);prepareUpload(text);
    if(current.upload&&current.upload.endpoint!==endpoint)throw Error('服务地址改变，不能迁移已冻结任务');
    current.upload={...current.upload,endpoint,text};current.sealedText=text;for(const e of chunk)e.batchId=id;
    data.jobs.push({id,groupId,bankId,endpoint,actor,confirmedAt:at,status:'queued',attempts:0,nextAt:0,error:''});
   }
  }
 });
}
export async function pauseUploads(){await updateLocal(data=>{for(const job of data.jobs||[])if(!['done','failed'].includes(job.status)){job.status='paused';job.error='已退出登录，任务保留';}});}
export async function retryUploads(){const actor=cloud.state().openid;if(!actor)return;await updateLocal(data=>{for(const j of data.jobs||[])if(j.actor===actor&&!['done','failed'].includes(j.status)){j.status='queued';j.nextAt=0;j.error='';}});}
export function runUploadQueue():Promise<void>{
 if(running)return running;
 const task=(async()=>{for(const job of (await readLocal()).jobs||[]){
  if(!readyJob(job)||!readyJob((await readLocal()).jobs?.find(j=>j.id===job.id)||job))continue;
  try{const {manifest}=await loadBank(job.bankId),endpoint=await cloud.authorize(job.bankId,manifest.name);
   if(endpoint!==job.endpoint||cloud.state().openid!==job.actor)throw new UploadError('登录身份或服务地址改变，请使用原身份恢复',403,'IDENTITY_CHANGED');
   const latest=(await readLocal()).jobs?.find(j=>j.id===job.id);if(latest?.status==='paused')continue;
   await updateLocal(d=>{const j=d.jobs!.find(j=>j.id===job.id)!;if(j.status!=='paused')j.status='uploading';});
   if((await readLocal()).jobs?.find(j=>j.id===job.id)?.status==='paused')continue;
   await uploadBatch(job.bankId,job.id,true,job.actor);
   await updateLocal(d=>{const j=d.jobs!.find(j=>j.id===job.id)!;j.status='done';j.error='';});
   await syncBank(job.bankId).then(()=>invalidateBank(job.bankId)).catch(()=>{});
  }catch(e){await updateLocal(d=>{const i=d.jobs!.findIndex(j=>j.id===job.id);if(i>=0&&!['done','paused'].includes(d.jobs![i].status))d.jobs![i]=failedJob(d.jobs![i],e);});}
 }})();running=task;void task.finally(()=>{running=undefined}).catch(()=>{});return task;
}
