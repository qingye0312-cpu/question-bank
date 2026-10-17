import {deltaPackage} from '../core/intake';
import {prepareUpload,verifyReceipt} from '../core/upload';
import {cloud} from './cloud';
import {loadBank} from './bank';
import {readLocal,updateLocal} from './intake-store';

const uploading=new Set<string>();
export async function uploadBatch(bankId:string,batchId:string){
  if(uploading.has(batchId))throw new Error('本批次正在上传，请稍候');
  uploading.add(batchId);
  try{
    const batch=(await readLocal()).batches.find(b=>b.id===batchId&&b.bankId===bankId);
    if(!batch)throw new Error('请选择当前题库的录入批次');
    const {manifest}=await loadBank(bankId);
    const endpoint=await cloud.authorize(bankId,manifest.name);
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
    const result=await cloud.upload(prepared,endpoint),receipt=verifyReceipt(result.receipt,prepared);
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
