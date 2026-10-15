import {parseModelReply,identityKey,sameAnswer,toQuestion,deltaPackage,parseDelta} from '../core/intake';
import {loadBank,invalidateBank,listBanks} from './bank';
import {readLocal,updateLocal,createIds} from './intake-store';
import type {Question} from '../core/search';
export async function compareReply(bankId:string,text:string){
 const reply=parseModelReply(text),{bank}=await loadBank(bankId),key=identityKey(reply),matches:Question[]=[];
 for(let i=0;i<bank.count;i++){const q=bank.question(i);if(identityKey(q)===key)matches.push(q);}
 return {reply,matches,status:!matches.length?'new':matches.every(q=>sameAnswer(q,reply))?'duplicate':'conflict'};
}
export async function saveReply(bankId:string,batchId:string,text:string){
 const comparison=await compareReply(bankId,text);
 if(comparison.status!=='new')return {comparison,batchId,added:false};
 const {manifest}=await loadBank(bankId),ids=await createIds(10),at=new Date().toISOString();
 const q=toQuestion(comparison.reply,manifest.name,ids,at),batch=batchId||ids();
 const added=await updateLocal(data=>{
  if(data.entries.some(e=>e.bankId===bankId&&identityKey(e.question)===identityKey(q)))return false;
  const existing=data.batches.find(b=>b.id===batch);if(existing&&existing.bankId!==bankId)throw new Error('批次属于其他题库');
  if(!existing)data.batches.push({id:batch,bankId,createdAt:at});
  if(!data.banks.some(b=>b.id===bankId))data.banks.push({id:bankId,name:manifest.name});
  data.entries.push({bankId,batchId:batch,question:q,createdAt:at,uploadStatus:'pending',exportedAt:'',sharedAt:''});return true;
 });
 invalidateBank(bankId);return {comparison,batchId:batch,added};
}
export async function markUpload(bankId:string,id:string,uploaded:boolean){
 await updateLocal(data=>{const e=data.entries.find(e=>e.bankId===bankId&&e.question.question_id===id);if(!e)throw new Error('记录不存在');e.uploadStatus=uploaded?'uploaded_manual':'pending'});
}
export async function exportBatch(batchId:string):Promise<{filePath:string;fileName:string}>{
 const data=await readLocal(),batch=data.batches.find(b=>b.id===batchId);if(!batch)throw new Error('请选择录入批次');
 const {manifest}=await loadBank(batch.bankId),at=new Date().toISOString();
 const questions=data.entries.filter(e=>e.bankId===batch.bankId&&e.batchId===batchId).map(e=>e.question);
 const payload=deltaPackage(batch.bankId,manifest.name,batchId,questions,at);
 const fileName=`${manifest.name.replace(/[\\/:*?"<>|]/g,'_')}_${batchId.slice(0,8)}.qbank-delta.json`;
 const filePath=`${wx.env.USER_DATA_PATH}/${fileName}`;
 const fs=wx.getFileSystemManager();
 await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:filePath+'.tmp',data:payload,encoding:'utf8',success:()=>resolve(),fail:reject}));
 await new Promise<void>((resolve,reject)=>fs.rename({oldPath:filePath+'.tmp',newPath:filePath,success:()=>resolve(),fail:reject}));
 await updateLocal(next=>{for(const e of next.entries)if(e.batchId===batchId)e.exportedAt=at});
 return {filePath,fileName};
}
export async function importDelta(text:string){
 const {delta,questions}=parseDelta(text),at=new Date().toISOString();
 const catalog=await listBanks();
 // A bundled bank may not yet have any local entries/catalog record.
 let previous:Question[]=[];
 if(catalog.some(b=>b.id===delta.bank_id)){const {bank}=await loadBank(delta.bank_id);previous=Array.from({length:bank.count},(_,i)=>bank.question(i))}
 const result=await updateLocal(data=>{
  const batch=data.batches.find(b=>b.id===delta.batch_id);if(batch&&batch.bankId!==delta.bank_id)throw new Error('增量包批次属于另一题库');
  const old=[...previous,...data.entries.filter(e=>e.bankId===delta.bank_id).map(e=>e.question)];
  const byId=new Map(old.map(q=>[q.question_id,q])),byContent=new Map<string,Question[]>();
  for(const q of old){const key=identityKey(q);byContent.set(key,[...(byContent.get(key)||[]),q])}
  let added=0,skipped=0,conflicts=0;
  if(!data.banks.some(b=>b.id===delta.bank_id))data.banks.push({id:delta.bank_id,name:delta.name});
  if(!batch)data.batches.push({id:delta.batch_id,bankId:delta.bank_id,createdAt:at});
  for(const q of questions){
   const key=identityKey(q),idMatch=byId.get(q.question_id),matches=byContent.get(key)||[];
   if(idMatch&&(identityKey(idMatch)!==key||!sameAnswer(idMatch,q))){conflicts++;continue;}
   if(idMatch||matches.length){if(matches.some(p=>!sameAnswer(p,q)))conflicts++;else skipped++;continue;}
   data.entries.push({bankId:delta.bank_id,batchId:delta.batch_id,question:q,createdAt:at,uploadStatus:'pending',exportedAt:'',sharedAt:''});
   byId.set(q.question_id,q);byContent.set(key,[q]);added++;
  }return {bankId:delta.bank_id,name:delta.name,added,skipped,conflicts};
 });invalidateBank(delta.bank_id);return result;
}
