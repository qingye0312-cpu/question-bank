// Generated from shared/draft.ts.
import {sha256} from './intake';
import {emptyReply,parseDraft,parseModelReply,editedReplyText,intakeMetadata,type ModelReply,type IntakeMetadata,type IntakeQuestion,replyFromQuestion,recordedTime} from './intake';

export type FieldIssue={field:string;message:string};
export type DraftRecord={id:string;bankId:string;revision:number;recordedAt:string;updatedAt:string;
 raw:string;original:string;reply:ModelReply|null;metadata:IntakeMetadata;sourceIssues:FieldIssue[];
 issues:FieldIssue[];removed:boolean;submissionId:string;publishedAt?:string;question?:IntakeQuestion};
export function newDraft(id:string,bankId:string,at=new Date().toISOString()):DraftRecord {
 return {id,bankId,revision:0,recordedAt:at,updatedAt:at,raw:'',original:'',reply:null,metadata:intakeMetadata(),sourceIssues:[],issues:[],removed:false,submissionId:''};
}
export function draftFromQuestion(bankId:string,q:IntakeQuestion):DraftRecord {
 const reply=replyFromQuestion(q),raw=JSON.stringify(reply,null,2);
 return {...newDraft(q.question_id,bankId,recordedTime(q)||''),reply,raw,original:raw,question:q,
  metadata:intakeMetadata({chapter:q.chapter,tags:q.tags,difficulty:q.difficulty as IntakeMetadata['difficulty'],applicable_version:q.applicable_version,external_id:q.external_id})};
}
export function parseModelText(raw:string):{reply:ModelReply|null;issues:FieldIssue[]} {
 try {
  const reply=parseDraft(raw),value=JSON.parse(raw.trim().replace(/^\uFEFF/,'').replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i,'$1'));
  const issues:FieldIssue[]=[];
  const keys=['format','type','stem','options','answer','answer_origin','explanation','model','warnings'];
  for(const key of Object.keys(value))if(!keys.includes(key))issues.push({field:key,message:`原文额外字段 ${key} 已保留，请核实其内容`});
  if(value.format&&value.format!=='qbank-photo-question-1')issues.push({field:'format',message:'原文格式标识不符，请核实原文'});
  if(Array.isArray(value.options))value.options.forEach((o:unknown,i:number)=>{
   if(!o||typeof o!=='object'||Object.keys(o).some(k=>!['key','content'].includes(k)))issues.push({field:`options.${i}`,message:`第 ${i+1} 项含非标准内容，完整内容保留在原文`});
  });
  for(const key of ['stem','explanation'])if(value[key]!=null&&typeof value[key]!=='string')issues.push({field:key,message:`${key} 不是文字，原值保留在原文`});
  if(value.options!=null&&!Array.isArray(value.options))issues.push({field:'options',message:'选项不是数组，完整原值已保留'});
  if(Array.isArray(value.options))value.options.forEach((o:any,i:number)=>{if(o?.content!=null&&typeof o.content!=='string')issues.push({field:`options.${i}`,message:`第 ${i+1} 项正文不是文字，原值保留在原文`});});
  if(Array.isArray(value.answer)&&value.answer.some((a:unknown)=>typeof a!=='string'))issues.push({field:'answer',message:'答案包含非文字选项标识，请核对原文'});
  if(value.answer_origin&&value.answer_origin!=='inferred')issues.push({field:'answer',message:'原文没有确认作答来源，请自行核实答案'});
  if(value.warnings!=null&&(!Array.isArray(value.warnings)||value.warnings.some((w:unknown)=>typeof w!=='string')))issues.push({field:'warnings',message:'内容提示含非文字数据，原值完整保留'});
  if(value.model!=null&&(typeof value.model!=='object'||Array.isArray(value.model)))issues.push({field:'model',message:'模型信息格式不完整，请核对'});
  if(value.model&&typeof value.model==='object'&&Object.keys(value.model).some(k=>!['name','version','version_source'].includes(k)))issues.push({field:'model',message:'模型信息含额外字段，已保留在原文'});
  return {reply,issues};
 }catch(e){return {reply:null,issues:[{field:'raw',message:String(e instanceof Error?e.message:e)}]};}
}
export function validateDraft(record:DraftRecord):{text?:string;issues:FieldIssue[]} {
 if(record.sourceIssues.length)return {issues:record.sourceIssues};
 if(!record.reply)return {issues:[{field:'stem',message:'粘贴题目或开始手工录题'}]};
 try {
  const text=editedReplyText(record.reply,record.original);parseModelReply(text);intakeMetadata(record.metadata);
  return {text,issues:[]};
 }catch(e){const message=e instanceof Error?e.message:String(e);return {issues:[{field:/答案/.test(message)?'answer':/选项/.test(message)?'options':'question',message}]};}
}
export function reviseDraft(record:DraftRecord,patch:Partial<DraftRecord>):DraftRecord {
 if(record.submissionId)throw Error('已提交内容保留原样，用于确认云端回执');
 const next={...record,...patch,revision:record.revision+1,updatedAt:new Date().toISOString()};
 return {...next,issues:validateDraft(next).issues};
}
export function pasteDraft(record:DraftRecord,raw:string):DraftRecord {
 const {reply,issues}=parseModelText(raw);return reviseDraft(record,{raw,original:raw,reply,sourceIssues:issues});
}
export function hasDraftContent(record:DraftRecord){return !!(record.raw||record.reply);}
export function isBlankDraft(record:DraftRecord){
 const hasText=(value:unknown)=>typeof value==='string'&&value.trim().length>0;
 if(hasText(record.raw)||hasText(record.original)||record.question)return false;
 const reply=record.reply;
 if(reply&&(reply.type!=='single'||hasText(reply.stem)||reply.options.some(option=>hasText(option.content))
  ||(Array.isArray(reply.answer)?reply.answer.length>0:typeof reply.answer==='boolean')
  ||hasText(reply.explanation)||reply.warnings.some(hasText)
  ||(hasText(reply.model.name)&&reply.model.name!=='未知')
  ||(hasText(reply.model.version)&&reply.model.version!=='未知')))return false;
 const metadata=record.metadata;
 return ![metadata.chapter,metadata.applicable_version,metadata.external_id].some(hasText)
  &&!metadata.tags.some(hasText)&&!metadata.difficulty;
}
export function startManual(record:DraftRecord){return reviseDraft(record,{reply:emptyReply(),raw:'',original:'',sourceIssues:[]});}

// Coalesce only writes that have not started. Every completed write advances the
// expected revision; failures retain the newest input for an explicit retry.
export class DraftAutosave {
 private pending=new Map<string,DraftRecord>();
 private revisions=new Map<string,number>();
 private running:Promise<void>|undefined;
 private timer:ReturnType<typeof setTimeout>|undefined;
 private write:(record:DraftRecord,expected:number)=>Promise<DraftRecord>;
 private saved:(record:DraftRecord)=>void;
 private failed:(error:unknown)=>void;
 constructor(write:(record:DraftRecord,expected:number)=>Promise<DraftRecord>,saved:(record:DraftRecord)=>void,failed:(error:unknown)=>void){this.write=write;this.saved=saved;this.failed=failed;}
 seed(records:DraftRecord[]){for(const r of records)this.revisions.set(r.id,r.revision);}
 set(record:DraftRecord){this.pending.set(record.id,record);if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.flush().catch(this.failed)},400);}
 async flush():Promise<void>{
  if(this.timer){clearTimeout(this.timer);this.timer=undefined;}
  if(this.running){await this.running;if(this.pending.size)return this.flush();return;}
  const run=(async()=>{while(this.pending.size){
   const [id,record]=this.pending.entries().next().value!;
   const result=await this.write(record,this.revisions.get(id)||0);
   this.revisions.set(id,result.revision);
   if(this.pending.get(id)===record)this.pending.delete(id);
   this.saved(result);
  }})();this.running=run;
  try{await run;}finally{this.running=undefined;}
 }
 dispose(){if(this.timer)clearTimeout(this.timer);}
}

// Stable migration IDs make a retry after a crash between files idempotent.
export function migrationId(bankId:string,slot:number,value:unknown){const h=sha256(JSON.stringify([bankId,slot,value]));return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
