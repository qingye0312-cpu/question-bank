import {parseModelReply,identityKey,sameAnswer,toQuestion,deltaPackage,parseDelta,intakeMetadata,resultName,sha256,recordedTime,withRecordedTime,type IntakeMetadata} from '../core/intake';
import {loadBank,invalidateBank,listBanks} from './bank';
import {readLocal,updateLocal,createIds} from './intake-store';
import {prepareUpload,unpackUpload} from '../core/upload';
import type {Question} from '../core/search';
export async function compareReply(bankId:string,text:string){
 const reply=parseModelReply(text),{bank}=await loadBank(bankId),key=identityKey(reply),matches:Question[]=[];
 for(let i=0;i<bank.count;i++){const q=bank.question(i);if(identityKey(q)===key)matches.push(q);}
 return {reply,matches,status:!matches.length?'new':matches.every(q=>sameAnswer(q,reply))?'duplicate':'conflict'};
}
export async function saveReply(bankId:string,batchId:string,text:string,metadata:Partial<IntakeMetadata>={}){
 const comparison=await compareReply(bankId,text);
 if(comparison.status!=='new')return {comparison,batchId,added:false};
 const {manifest}=await loadBank(bankId),ids=await createIds(10),at=new Date().toISOString();
 const q={...toQuestion(comparison.reply,manifest.name,ids,at),...intakeMetadata(metadata)};let batch=batchId||ids();
 const added=await updateLocal(data=>{
  if(data.entries.some(e=>e.bankId===bankId&&identityKey(e.question)===identityKey(q)))return false;
  let existing=data.batches.find(b=>b.id===batch);if(existing&&existing.bankId!==bankId)throw new Error('批次属于其他题库');
  // Once a submission may have reached the self-host service its exact bytes
  // must remain retryable.
  if(existing?.sealedText||existing?.upload){batch=ids();existing=undefined;}
  if(!existing)data.batches.push({id:batch,bankId,createdAt:at});
  if(!data.banks.some(b=>b.id===bankId))data.banks.push({id:bankId,name:manifest.name});
  data.entries.push({bankId,batchId:batch,question:q,createdAt:at,uploadStatus:'pending',exportedAt:'',sharedAt:''});return true;
 });
 invalidateBank(bankId);return {comparison,batchId:batch,added};
}
export async function markUpload(bankId:string,id:string,uploaded:boolean){
 await updateLocal(data=>{const e=data.entries.find(e=>e.bankId===bankId&&e.question.question_id===id);if(!e)throw new Error('记录不存在');
  if(data.batches.find(b=>b.id===e.batchId)?.upload)throw new Error('云端上传状态由回执确认，不能手动更改');
  e.uploadStatus=uploaded?'uploaded_manual':'pending'});
}
export async function exportBatch(batchId:string,compressed=false):Promise<{filePath:string;fileName:string}>{
 const data=await readLocal(),batch=data.batches.find(b=>b.id===batchId);if(!batch)throw new Error('请选择录入批次');
 const {manifest}=await loadBank(batch.bankId),at=new Date().toISOString();
 // Export is an independent exchange snapshot, never a submission lock.
 const exportId=(await createIds(1))();
 const payload=batch.upload?.text||batch.sealedText||deltaPackage(batch.bankId,manifest.name,exportId,
  data.entries.filter(e=>e.bankId===batch.bankId&&e.batchId===batchId).map(e=>e.question),at);
 const fileName=resultName(batch.createdAt,manifest.name,'增量','b'+batchId.slice(0,8),batch.bankId,sha256(payload))+`.${compressed?'qbank-upload':'qbank-delta'}.json`;
 const filePath=`${wx.env.USER_DATA_PATH}/${fileName}`;
 const fs=wx.getFileSystemManager();
 await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:filePath+'.tmp',data:compressed?JSON.stringify(prepareUpload(payload).envelope):payload,encoding:'utf8',success:()=>resolve(),fail:reject}));
 await new Promise<void>((resolve,reject)=>fs.rename({oldPath:filePath+'.tmp',newPath:filePath,success:()=>resolve(),fail:reject}));
 await updateLocal(next=>{for(const e of next.entries)if(e.batchId===batchId)e.exportedAt=at});
 return {filePath,fileName};
}
export async function importDelta(text:string){
 text=unpackUpload(text);
 const {delta,questions}=parseDelta(text),at=new Date().toISOString(),ids=await createIds(1);
 const catalog=await listBanks();
 // A bundled bank may not yet have any local entries/catalog record.
 let previous:Question[]=[];
 if(catalog.some(b=>b.id===delta.bank_id)){const {bank}=await loadBank(delta.bank_id);previous=Array.from({length:bank.count},(_,i)=>bank.question(i))}
 const result=await updateLocal(data=>{
  const batch=data.batches.find(b=>b.id===delta.batch_id);if(batch&&batch.bankId!==delta.bank_id)throw new Error('增量包批次属于另一题库');
  const old=[...previous,...data.entries.filter(e=>e.bankId===delta.bank_id).map(e=>e.question)];
  const byId=new Map(old.map(q=>[q.question_id,q])),byContent=new Map<string,(Question|import('../core/intake').IntakeQuestion)[]>();
  for(const q of old){const key=identityKey(q);byContent.set(key,[...(byContent.get(key)||[]),q])}
  let skipped=0,conflicts=0;const incoming:typeof questions=[];
  if(!data.banks.some(b=>b.id===delta.bank_id))data.banks.push({id:delta.bank_id,name:delta.name});
  for(const q of questions){
   const key=identityKey(q),idMatch=byId.get(q.question_id),matches=byContent.get(key)||[];
   if(idMatch&&(identityKey(idMatch)!==key||!sameAnswer(idMatch,q))){conflicts++;continue;}
   if(idMatch||matches.length){if(matches.some(p=>!sameAnswer(p,q)))conflicts++;else skipped++;continue;}
   incoming.push(recordedTime(q)?q:withRecordedTime(q,at));byId.set(q.question_id,q);byContent.set(key,[q]);
  }
  if(incoming.length){
   // A filtered import is a different package: never reuse the sender's batch ID
   // for only a subset, or append content to an already exported/submitted batch.
   const complete=!batch&&incoming.length===questions.length&&JSON.stringify(incoming)===JSON.stringify(questions),batchId=complete?delta.batch_id:ids();
   const createdAt=complete?delta.created_at:at;
   data.batches.push({id:batchId,bankId:delta.bank_id,createdAt,sealedText:complete?text:deltaPackage(delta.bank_id,delta.name,batchId,incoming,at)});
   for(const q of incoming)data.entries.push({bankId:delta.bank_id,batchId,question:q,createdAt:at,uploadStatus:'pending',exportedAt:'',sharedAt:''});
  }
  return {bankId:delta.bank_id,name:delta.name,added:incoming.length,skipped,conflicts};
 });invalidateBank(delta.bank_id);return result;
}

export async function editReply(bankId:string,id:string,text:string,metadata:Partial<IntakeMetadata>={}){
 const reply=parseModelReply(text),{bank}=await loadBank(bankId),key=identityKey(reply);
 for(let i=0;i<bank.count;i++){const q=bank.question(i);if(q.question_id!==id&&identityKey(q)===key)throw Error('修改后与已有题目重复或答案冲突');}
 const ids=await createIds(9),at=new Date().toISOString();
 await updateLocal(data=>{const entry=data.entries.find(e=>e.bankId===bankId&&e.question.question_id===id);if(!entry)throw Error('录入题目不存在');
  const batch=data.batches.find(b=>b.id===entry.batchId);if(batch?.sealedText||batch?.upload)throw Error('批次已冻结，请另存新批次');
  const old=entry.question,q={...toQuestion(reply,old.bank,ids,at),...intakeMetadata(metadata),question_id:id,base_revision:old.base_revision+1,recorded_at:recordedTime(old),recorded_at_source:old.recorded_at_source||(recordedTime(old)?'source':'unknown') as 'source'|'unknown',updated_at:at};
  q.sources[0].recorded_at=recordedTime(old);
  if(data.entries.some(e=>e.bankId===bankId&&e.question.question_id!==id&&identityKey(e.question)===identityKey(q)))throw Error('修改后与已有新题重复');entry.question=q;
 });invalidateBank(bankId);
}
