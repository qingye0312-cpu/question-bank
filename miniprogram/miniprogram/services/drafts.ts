import {draftFromQuestion,migrationId,newDraft,pasteDraft,validateDraft,type DraftRecord} from '../core/draft';
import {toQuestion,identityKey,intakeMetadata,deltaPackage,type ModelReply,type IntakeMetadata} from '../core/intake';
import {prepareUpload} from '../core/upload';
import {readLocal,createIds,updateLocal} from './intake-store';
import {readDraftFile,writeDraftFile,withDraftLock} from './draft-repository';
import {loadBank,invalidateBank} from './bank';
import {cloud} from './cloud';

async function withSubmission(records:DraftRecord[]){
 const local=await readLocal();return records.map(r=>{
  const job=local.jobs?.find(j=>j.recordIds?.includes(r.id));
  const entry=local.entries.find(e=>e.bankId===r.bankId&&e.question.question_id===r.id),batch=entry&&local.batches.find(b=>b.id===entry.batchId);
  return {...r,submissionId:job?.id||r.submissionId||(batch?.upload?batch.id:'')};
 });
}
export async function listDrafts(bankId:string){return withDraftLock(async()=>{
 let records=await readDraftFile(bankId);const local=await readLocal(),legacy=local.drafts?.[bankId];
 let changed=false;
 for(const e of local.entries.filter(e=>e.bankId===bankId&&e.uploadStatus==='pending'))if(!records.some(r=>r.id===e.question.question_id)){
  records=[...records,{...draftFromQuestion(bankId,e.question),revision:1}];changed=true;
 }
 if(legacy&&!legacy.migrated){for(const [slot,old] of [legacy.current,legacy.previous].entries()){
  if(!old)continue;const id=migrationId(bankId,slot,old);if(records.some(r=>r.id===id))continue;
  if(!old.text&&!old.reply||old.editing&&records.some(r=>r.id===old.editing))continue;
  let r=pasteDraft(newDraft(id,bankId),typeof old.text==='string'?old.text:JSON.stringify(old.reply));
  if(old.reply)r={...r,reply:old.reply as ModelReply,original:typeof old.original==='string'?old.original:r.original,metadata:intakeMetadata((old.metadata||{}) as Partial<IntakeMetadata>)};
  r.issues=validateDraft(r).issues;records=[...records,r];changed=true;
 }}
 if(changed)await writeDraftFile(bankId,records);
 if(legacy&&!legacy.migrated)await updateLocal(d=>{d.drafts![bankId].migrated=true});
 return withSubmission(records);
 });}
export function saveDraft(record:DraftRecord,expected:number){return withDraftLock(async()=>{
 const records=await withSubmission(await readDraftFile(record.bankId)),old=records.find(r=>r.id===record.id);
 if(!Number.isSafeInteger(record.revision)||record.revision<=expected)throw Error('草稿版本无效');
 if((old?.revision||0)!==expected)throw Error('题目已改变，请重新打开；当前输入没有覆盖旧记录');
 if(old?.submissionId)throw Error('内容已提交，保留原包用于核对回执');
 const next={...record,recordedAt:old?old.recordedAt:record.recordedAt,updatedAt:new Date().toISOString()},validation=validateDraft(next);next.issues=validation.issues;
 if(validation.text&&!next.removed){
  const {bank,manifest}=await loadBank(record.bankId),ids=await createIds(9);
  const q={...toQuestion(JSON.parse(validation.text),manifest.name,ids,next.recordedAt),...intakeMetadata(next.metadata),question_id:next.id,base_revision:next.revision,updated_at:next.updatedAt};
  q.recorded_at=next.recordedAt||null;q.recorded_at_source=next.recordedAt?(old?.question?.recorded_at_source||'local'):'unknown';q.sources[0].recorded_at=q.recorded_at;
  for(const option of q.options){const previous=old?.question?.options.find(o=>o.content===option.content);if(previous)option.option_id=previous.option_id;}
  for(let i=0;i<bank.count;i++){const previous=bank.question(i);if(previous.question_id!==q.question_id&&identityKey(previous)===identityKey(q)){next.issues=[{field:'question',message:'与已有题目重复或答案冲突，请修改或移除本条'}];break;}}
  next.question=q;
 }
 const updated=records.some(r=>r.id===next.id)?records.map(r=>r.id===next.id?next:r):[...records,next];
 await writeDraftFile(record.bankId,updated);invalidateBank(record.bankId);return next;
 });}
export async function submitDrafts(bankId:string,expected:{id:string;revision:number}[],note=''){
 const {manifest}=await loadBank(bankId),endpoint=await cloud.authorize(bankId,manifest.name),actor=cloud.state().openid;if(!actor)throw Error('请重新登录');
 const normalized=note.trim();if(normalized.length>500)throw Error('上传备注不能超过 500 字');
 const health=await cloud.health();if(!(health.capabilities as string[]||[]).includes('session-upload-v1'))throw Error('请先更新云端服务');
 return withDraftLock(async()=>{
  const records=(await withSubmission(await readDraftFile(bankId))).filter(r=>!r.removed&&!r.submissionId);
  if(JSON.stringify(records.map(r=>({id:r.id,revision:r.revision})))!==JSON.stringify(expected))throw Error('记录已变化，请核对后重新上传');
  if(!records.length||records.some(r=>r.issues.length||!r.question))throw Error('请先补全或移除未完成题目');
  const id=(await createIds(1))(),at=new Date().toISOString(),text=deltaPackage(bankId,manifest.name,id,records.map(r=>r.question!),at);
  prepareUpload(text); // Validate the whole session. Never turn it into per-question requests.
  await updateLocal(data=>{
   if(cloud.state().openid!==actor)throw Error('登录身份已改变，请重新核对');
   data.jobs=data.jobs||[];data.batches.push({id,bankId,createdAt:at,upload:{endpoint,text}});
   for(const r of records){data.entries=data.entries.filter(e=>!(e.bankId===bankId&&e.question.question_id===r.id));data.entries.push({bankId,batchId:id,question:r.question!,createdAt:r.recordedAt,uploadStatus:'pending',exportedAt:'',sharedAt:''});}
   data.jobs.push({id,groupId:id,bankId,endpoint,actor,confirmedAt:at,status:'queued',attempts:0,nextAt:0,error:'',protocol:'session-v1',recordIds:records.map(r=>r.id),note:normalized});
  });return id;
 });
}
export async function exportDrafts(bankId:string){
 const records=(await listDrafts(bankId)).filter(r=>!r.removed&&!r.submissionId);
 if(!records.length||records.some(r=>r.issues.length||!r.question))throw Error('请先补全要导出的题目');
 const {manifest}=await loadBank(bankId),id=(await createIds(1))(),at=new Date().toISOString();
 const envelope=prepareUpload(deltaPackage(bankId,manifest.name,id,records.map(r=>r.question!),at)).envelope;
 const fileName=`${at.replace(/[:.]/g,'-')}_录题_${id.slice(0,8)}.qbank-upload.json`,filePath=`${wx.env.USER_DATA_PATH}/${fileName}`,fs=wx.getFileSystemManager();
 await new Promise<void>((resolve,reject)=>fs.writeFile({filePath:filePath+'.tmp',encoding:'utf8',data:JSON.stringify(envelope),success:()=>resolve(),fail:reject}));
 await new Promise<void>((resolve,reject)=>fs.rename({oldPath:filePath+'.tmp',newPath:filePath,success:()=>resolve(),fail:reject}));return {filePath,fileName};
}
