import {DraftAutosave,newDraft,pasteDraft,reviseDraft,type DraftRecord} from '../core/draft';
import {displayTime,emptyReply} from '../core/intake';
import {createIds,readLocal} from './intake-store';
import {listDrafts,saveDraft,submitDrafts,exportDrafts} from './drafts';
import {runUploadQueue,retryUploads,syncUploadedBank} from './cloud-intake';
import type {UploadJob} from '../core/queue';
export const jobLabels={queued:'等待上传',uploading:'上传中',retry:'自动重试中',paused:'需要登录',failed:'需要处理',done:'回执已保存'};
export function intakeView(record:DraftRecord|null,records:DraftRecord[],jobs:UploadJob[]){
 const reply=record?.reply||null,pending=records.filter(r=>!r.removed&&!r.submissionId);
 const visibleRecords=records.filter(r=>{if(r.removed)return false;const job=jobs.find(j=>j.id===r.submissionId);return job?.status!=='done'});
 return {currentId:record?.id||'',reply,locked:!!record?.submissionId,raw:record?.raw||'',issues:record?.issues||[],sourceIssues:record?.sourceIssues||[],recordedAt:displayTime(record?.recordedAt),metadata:record?.metadata,
  editOptions:reply?.options.map(o=>({...o,correct:Array.isArray(reply.answer)&&reply.answer.includes(o.key)}))||[],boolSelected:typeof reply?.answer==='boolean',typeIndex:Math.max(0,['single','multiple','true_false'].indexOf(reply?.type||'')),
  sourceIndex:['platform','user','unknown'].indexOf(reply?.model.version_source||'unknown'),warningsText:reply?.warnings.join('\n')||'',tagsText:record?.metadata.tags.join('|')||'',difficultyIndex:['','easy','medium','hard'].indexOf(record?.metadata.difficulty||''),pendingCount:pending.length,
  records:visibleRecords.map(r=>{const job=jobs.find(j=>j.id===r.submissionId);return {id:r.id,stem:r.reply?.stem||'未完成的题目',recordedAt:displayTime(r.recordedAt),editable:!r.submissionId,invalid:!!r.issues.length&&!r.submissionId,
   status:r.submissionId?(job?jobLabels[job.status]:'待找回原提交回执'):r.issues.length?'待补全':'待上传',issue:r.issues[0]?.message||''};}),
  jobs:jobs.filter(j=>j.status!=='done'||!!j.syncError).map(j=>({...j,label:jobLabels[j.status],time:displayTime(j.confirmedAt)))};
}
export class IntakeController {
 bankId='';current:DraftRecord|null=null;records:DraftRecord[]=[];jobs:UploadJob[]=[];saved='已存本机';error='';notice='';private jobsReady=false;private previousJobStatus=new Map<string,UploadJob['status']>();
 private saver:DraftAutosave;
 private disposed=false;
 constructor(private emit:(view:ReturnType<typeof intakeView>&{saved:string;error:string;notice:string})=>void){
  this.saver=new DraftAutosave(saveDraft,r=>{this.records=this.records.map(v=>v.id===r.id&&v.revision===r.revision?r:v);if(this.current?.id===r.id&&this.current.revision===r.revision){this.current=r;this.saved='已存本机'}this.render()},e=>{this.saved='保存失败，请重试';this.error=String(e);this.render()});
 }
 render(){if(!this.disposed){const notice=this.notice;this.notice='';this.emit({...intakeView(this.current,this.records,this.jobs),saved:this.saved,error:this.error,notice})}}
 async open(bank:string){await this.flush();const records=await listDrafts(bank);if(bank!==this.bankId){this.jobsReady=false;this.previousJobStatus.clear();this.notice=''}this.bankId=bank;this.records=records;this.saver.seed(this.records);this.current=[...this.records].reverse().find(r=>!r.removed&&!r.submissionId)||newDraft((await createIds(1))(),bank);await this.refreshJobs();this.render();}
 async refreshJobs(){const next=((await readLocal()).jobs||[]).filter(j=>j.bankId===this.bankId);if(this.jobsReady){const completed=next.filter(j=>j.status==='done'&&this.previousJobStatus.get(j.id)!=='done');if(completed.length)this.notice=`${completed.length} 个上传批次已成功合并，待上传列表已清空。`}this.previousJobStatus=new Map(next.map(j=>[j.id,j.status]));this.jobs=next;this.jobsReady=true;this.render();}
 stage(r:DraftRecord){this.current=r;this.records=this.records.some(v=>v.id===r.id)?this.records.map(v=>v.id===r.id?r:v):[...this.records,r];this.saved='保存中…';this.error='';this.saver.set(r);this.render();}
 change(patch:Partial<DraftRecord>){if(this.current&&!this.current.submissionId)this.stage(reviseDraft(this.current,patch));}
 paste(raw:string){if(this.current&&!this.current.submissionId)this.stage(pasteDraft(this.current,raw));}
 manual(){this.change({reply:emptyReply(),sourceIssues:[]});}
 async flush(){try{await this.saver.flush()}catch(e){this.error=String(e);this.saved='保存失败，请重试';this.render();throw e;}}
 async next(){await this.flush();const metadata=this.current?.metadata;this.current=newDraft((await createIds(1))(),this.bankId);if(metadata)this.current.metadata={...metadata,external_id:''};this.render();}
 async select(id:string){await this.flush();this.current=this.records.find(r=>r.id===id)||this.current;this.render();}
 async remove(id:string){await this.flush();const r=this.records.find(r=>r.id===id);if(!r)return;this.stage(reviseDraft(r,{removed:true}));await this.flush();await this.next();}
 async upload(){await this.flush();const pending=this.records.filter(r=>!r.removed&&!r.submissionId);
  if(pending.some(r=>r.issues.length))throw Error('还有待补全题目，请修改或删除后上传');
  await submitDrafts(this.bankId,pending.map(r=>({id:r.id,revision:r.revision})));
  this.records=await listDrafts(this.bankId);this.saver.seed(this.records);await this.next();await this.refreshJobs();void runUploadQueue().then(()=>this.refreshJobs()).catch(e=>{this.error=String(e);this.render()});
 }
 async retry(){await retryUploads(true);void runUploadQueue().then(()=>this.refreshJobs()).catch(e=>{this.error=String(e);this.render()});}
 async sync(){await syncUploadedBank(this.bankId);await this.refreshJobs();}
 async export(){await this.flush();return exportDrafts(this.bankId);}
 dispose(){this.disposed=true;this.saver.dispose();void this.flush().catch(()=>{});}
}
