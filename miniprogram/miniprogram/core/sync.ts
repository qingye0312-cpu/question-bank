// Generated from shared/sync.ts.
import {unpackText,CLOUD_FILE_FORMAT} from './codec';
import {validTime,validateStandardQuestion,sha256,identityKey,type IntakeQuestion} from './intake';
export type SyncQuestion=Omit<IntakeQuestion,'answer'> & {answer:string[]|boolean|null; cloud_layer?:string};
export type CloudManifest={bank_id:string;name:string;revision:number;release_version:number;release_version_label?:string|null;sha256:string;bytes:number;minimum_client:string;updated_at:string;snapshot_format:string;protocol:2|3;question_file_sha256?:string|null;question_file_bytes?:number|null;question_file_format?:string|null;operations_file_sha256?:string|null;operations_file_bytes?:number|null;operations_file_format?:string|null;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null};
export type CloudSnapshot={format:'qbank-snapshot-2';merged_at?:string|null;release_name?:string|null;release_id?:string|null;release_version_label?:string|null;rollback_at?:string|null;rollback_of?:number|null;merges?:{batch_id:string;merged_at:string;question_count:number;added_count:number;duplicate_count:number;revision:number;release_version:number;release_version_label?:string|null}[];bank_id:string;name:string;revision:number;release_version:number;updated_at:string;
 formal:SyncQuestion[]|null;pending:SyncQuestion[];removed:{question_id:string;status:'merged'}[]};
export type CloudQuestionFile={format:'qbank-question-bank-1';bank_id:string;name:string;revision:number;release_version:number;release_version_label?:string|null;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;questions:SyncQuestion[]|null};
export type CloudOperationQuestion={question_id:string;action:'added'|'revised'|'restored'|'removed';uploaded_at:string;uploader:{account_id?:string|null;real_name?:string|null;nickname?:string|null;auth_type?:string|null};entered_revision?:number|null;entered_release_version?:number|null;revision?:number;release_version?:number;release_version_label?:string|null};
export type CloudOperationRevision={revision:number;kind:'seed'|'merge'|'rollback'|'state';release_version:number;release_version_label?:string|null;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;batch_id?:string|null;question_count:number;added_count:number;changed_count:number;duplicate_count:number;revised_count:number;removed_count:number;rollback_of?:number|null;uploader:{account_id?:string|null;real_name?:string|null;nickname?:string|null;auth_type?:string|null};questions:CloudOperationQuestion[]};
export type CloudOperationAggregate={question_id:string;first_revision?:number|null;first_release_version?:number|null;first_release_version_label?:string|null;first_uploaded_at?:string|null;first_uploader?:CloudOperationRevision['uploader']|null;revisions:CloudOperationQuestion[]};
export type CloudOperationsFile={format:'qbank-operations-1';bank_id:string;name:string;current_revision:number;current_release_version:number;current_release_version_label?:string|null;updated_at:string;revisions:CloudOperationRevision[];questions:CloudOperationAggregate[]};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const validUploader=(value:unknown)=>{if(!value||typeof value!=='object')return false;const item=value as Record<string,unknown>;return ['account_id','real_name','nickname','auth_type'].every(key=>item[key]==null||typeof item[key]==='string');};
export function readManifest(value:unknown):CloudManifest{
 const m=value as CloudManifest;
 if(!m||!uuid.test(m.bank_id)||typeof m.name!=='string'||!m.name.trim()||m.name.length>100||!Number.isSafeInteger(m.revision)||m.revision<0
  ||!Number.isSafeInteger(m.release_version)||m.release_version<0||!/^[0-9a-f]{64}$/.test(m.sha256)||!Number.isSafeInteger(m.bytes)||m.bytes<0||m.bytes>4194304
  ||typeof m.minimum_client!=='string'||!/^\d+\.\d+\.\d+$/.test(m.minimum_client))throw Error('云端版本清单无效，继续使用已缓存题库');
 if((m.protocol!==2&&m.protocol!==3)||m.snapshot_format!==CLOUD_FILE_FORMAT)throw Error('题库协议不受支持，请升级程序');
 const questionFields=[m.question_file_sha256,m.question_file_bytes,m.question_file_format],operationFields=[m.operations_file_sha256,m.operations_file_bytes,m.operations_file_format],hasQuestionFields=questionFields.some(value=>value!=null),hasOperationFields=operationFields.some(value=>value!=null);
 const validQuestionFields=typeof m.question_file_sha256==='string'&&/^[a-f0-9]{64}$/.test(m.question_file_sha256)&&typeof m.question_file_bytes==='number'&&Number.isSafeInteger(m.question_file_bytes)&&m.question_file_bytes>=0&&m.question_file_bytes<=4194304&&m.question_file_format==='qbank-question-bank-1';
 const validOperationFields=typeof m.operations_file_sha256==='string'&&/^[a-f0-9]{64}$/.test(m.operations_file_sha256)&&typeof m.operations_file_bytes==='number'&&Number.isSafeInteger(m.operations_file_bytes)&&m.operations_file_bytes>=0&&m.operations_file_bytes<=4194304&&m.operations_file_format==='qbank-operations-1';
 if(hasQuestionFields&&!validQuestionFields||hasOperationFields&&!validOperationFields)throw Error('云端题库文件清单无效');
 const needed=m.minimum_client.split('.').map(Number),current=[0,2,7];
 for(let i=0;i<3;i++){if(needed[i]>current[i])throw Error('此题库需要更新客户端，请先升级程序');if(needed[i]<current[i])break;}
 const validReleaseName=m.release_name==null||(typeof m.release_name==='string'&&m.release_name.length<=220&&!/[\\/:*?"<>|\x00-\x1f]/.test(m.release_name));
 const validReleaseLabel=m.release_version_label==null||(typeof m.release_version_label==='string'&&/^v\d+(?:\.\d+)?$/.test(m.release_version_label));
 if(m.merged_at!=null&&!validTime(m.merged_at)||m.rollback_at!=null&&!validTime(m.rollback_at)||m.rollback_of!=null&&(!Number.isSafeInteger(m.rollback_of)||m.rollback_of<1)||m.release_id!=null&&!/^[a-f0-9]{64}$/.test(m.release_id)||!validReleaseName||!validReleaseLabel)throw Error('云端结果名称或时间无效');
 return m;
}
export function snapshotPayload(value:unknown):{payload:string;sha256:string}{
 const v=value as {format?:string;sha256?:string};
 if(!v||v.format!==CLOUD_FILE_FORMAT||typeof v.sha256!=='string')throw Error('云端快照封装无效');
 return {payload:unpackText(v),sha256:v.sha256};
}
export function snapshotPath(m:CloudManifest){return `/v1/banks/${m.bank_id}/snapshot-file`;}
export function questionFilePath(m:CloudManifest){return `/v1/banks/${m.bank_id}/question-file`;}
export function operationsFilePath(m:CloudManifest){return `/v1/banks/${m.bank_id}/operations-file`;}
function filePayload(value:unknown):{payload:string;sha256:string}{
 const v=value as {format?:string;sha256?:string};
 if(!v||v.format!==CLOUD_FILE_FORMAT||typeof v.sha256!=='string')throw Error('云端文件封装无效');
 return {payload:unpackText(v),sha256:v.sha256};
}
export function questionFilePayload(value:unknown,m:CloudManifest):{payload:string;sha256:string}{
 const w=filePayload(value);if(m.question_file_sha256&&w.sha256!==m.question_file_sha256)throw Error('云端题库摘要校验失败');
 if(sha256(w.payload)!==w.sha256)throw Error('云端题库摘要校验失败');
 if(m.question_file_bytes!=null&&byteLength(w.payload)!==m.question_file_bytes)throw Error('云端题库大小不一致');
 return w;
}
export function operationsFilePayload(value:unknown,m:CloudManifest):{payload:string;sha256:string}{
 const w=filePayload(value);if(m.operations_file_sha256&&w.sha256!==m.operations_file_sha256)throw Error('云端修订记录摘要校验失败');
 if(sha256(w.payload)!==w.sha256)throw Error('云端修订记录摘要校验失败');
 if(m.operations_file_bytes!=null&&byteLength(w.payload)!==m.operations_file_bytes)throw Error('云端修订记录大小不一致');
 return w;
}
function byteLength(value:string){let bytes=0;for(const c of value){const p=c.codePointAt(0)!;bytes+=p<128?1:p<2048?2:p<65536?3:4;}return bytes;}
export function readQuestionFile(value:unknown,m:CloudManifest):CloudQuestionFile{
 const w=questionFilePayload(value,m);if(w.payload.length>4194304)throw Error('云端题库文件过大');
 const file=JSON.parse(w.payload) as CloudQuestionFile;
 if(file.format!=='qbank-question-bank-1'||file.bank_id!==m.bank_id||file.name!==m.name||file.revision!==m.revision||file.release_version!==m.release_version||file.release_version_label!==m.release_version_label||!Array.isArray(file.questions)||file.questions.length>20000||typeof file.updated_at!=='string'||file.updated_at!==m.updated_at||!validTime(file.updated_at)||file.merged_at!==m.merged_at||file.release_name!==m.release_name||file.release_id!==m.release_id||file.rollback_at!==m.rollback_at||file.rollback_of!==m.rollback_of)throw Error('云端题库身份或结构无效');
 const ids=new Set<string>();for(const question of file.questions){if(question&&question.status==='verified'&&question.type!=='programming'&&question.answer===null&&Array.isArray(question.issues)&&question.issues.length)question.status='needs_review';validateStandardQuestion(question,file.name);if(ids.has(question.question_id))throw Error('云端题目 ID 重复');ids.add(question.question_id);}
 return file;
}
export function readOperationsFile(value:unknown,m:CloudManifest):CloudOperationsFile{
 const w=operationsFilePayload(value,m);if(w.payload.length>4194304)throw Error('云端修订记录过大');
 const file=JSON.parse(w.payload) as CloudOperationsFile;
 if(file.format!=='qbank-operations-1'||file.bank_id!==m.bank_id||file.name!==m.name||file.current_revision!==m.revision||file.current_release_version!==m.release_version||file.current_release_version_label!==m.release_version_label||!Array.isArray(file.revisions)||!Array.isArray(file.questions)||file.revisions.length>10000||file.questions.length>20000||typeof file.updated_at!=='string'||file.updated_at!==m.updated_at||!validTime(file.updated_at))throw Error('云端修订记录身份或结构无效');
 const revisions=new Set<number>();for(const revision of file.revisions){if(!revision||!Number.isSafeInteger(revision.revision)||revision.revision<1||revisions.has(revision.revision)||!['seed','merge','rollback','state'].includes(revision.kind)||!nonnegative(revision.release_version)||!nonnegative(revision.question_count)||!nonnegative(revision.added_count)||!nonnegative(revision.changed_count)||!nonnegative(revision.duplicate_count)||!nonnegative(revision.revised_count)||!nonnegative(revision.removed_count)||revision.changed_count!==revision.added_count+revision.revised_count||!validUploader(revision.uploader)||!Array.isArray(revision.questions)||!validTime(revision.updated_at)||revision.merged_at!=null&&!validTime(revision.merged_at)||revision.release_version_label!=null&&!/^v\d+(?:\.\d+)?$/.test(revision.release_version_label)||revision.rollback_of!=null&&!nonnegative(revision.rollback_of))throw Error('云端修订记录无效');revisions.add(revision.revision);for(const event of revision.questions){if(!event||!uuid.test(event.question_id)||!['added','revised','restored','removed'].includes(event.action)||typeof event.uploaded_at!=='string'||!validTime(event.uploaded_at)||!validUploader(event.uploader)||event.entered_revision!=null&&!nonnegative(event.entered_revision)||event.entered_release_version!=null&&!nonnegative(event.entered_release_version)||event.revision!=null&&!nonnegative(event.revision)||event.release_version!=null&&!nonnegative(event.release_version)||event.release_version_label!=null&&!/^v\d+(?:\.\d+)?$/.test(event.release_version_label))throw Error('云端题目修订记录无效');}}
 if(file.current_revision>0&&!revisions.has(file.current_revision))throw Error('云端修订记录缺少当前修订');
 for(const aggregate of file.questions){if(!aggregate||!uuid.test(aggregate.question_id)||aggregate.first_uploader!=null&&!validUploader(aggregate.first_uploader)||!Array.isArray(aggregate.revisions)||aggregate.first_revision!=null&&!nonnegative(aggregate.first_revision)||aggregate.first_release_version!=null&&!nonnegative(aggregate.first_release_version)||aggregate.first_uploaded_at!=null&&!validTime(aggregate.first_uploaded_at))throw Error('云端题目历史记录无效');}
 return file;
}
export function readSnapshot(value:unknown,m:CloudManifest):CloudSnapshot{
 const w=snapshotPayload(value);
 if(!w||typeof w.payload!=='string'||w.payload.length>4194304||w.sha256!==m.sha256||sha256(w.payload)!==m.sha256)throw Error('云端题库摘要校验失败');
 // UTF-8 byte length without TextEncoder in the Mini Program.
 let bytes=0;for(const c of w.payload){const p=c.codePointAt(0)!;bytes+=p<128?1:p<2048?2:p<65536?3:4;}
 if(bytes!==m.bytes)throw Error('云端题库大小不一致');
 const s=JSON.parse(w.payload) as CloudSnapshot;
 if(s.format!=='qbank-snapshot-2'||s.bank_id!==m.bank_id||s.name!==m.name||s.revision!==m.revision||s.release_version!==m.release_version
  ||!(s.formal===null||Array.isArray(s.formal))||!Array.isArray(s.pending)||!Array.isArray(s.removed)||(s.formal?.length||0)+s.pending.length>20000)throw Error('云端题库身份或结构无效');
 if(s.merged_at!==m.merged_at||s.release_name!==m.release_name||s.release_id!==m.release_id||s.rollback_at!==m.rollback_at||s.rollback_of!==m.rollback_of)throw Error('版本结果信息不一致');
 if(s.rollback_at!=null&&!validTime(s.rollback_at)||s.rollback_of!=null&&(!Number.isSafeInteger(s.rollback_of)||s.rollback_of<1))throw Error('回退版本信息无效');
 if(s.merges!=null&&(!Array.isArray(s.merges)||s.merges.length>10000||s.merges.some(m=>!m||typeof m.batch_id!=='string'||!uuid.test(m.batch_id)||!validTime(m.merged_at)||![m.question_count,m.added_count,m.duplicate_count,m.revision,m.release_version].every(Number.isSafeInteger))))throw Error('合并记录无效');
 for(const layer of [s.formal||[],s.pending]){
  const ids=new Set();for(const q of layer){
   // Older released snapshots can mark an unresolved question as verified.
   // Preserve its text and issue, but present it as a review item so one
   // missing answer does not block downloading the entire bank.
   if(q&&q.status==='verified'&&q.type!=='programming'&&q.answer===null&&Array.isArray(q.issues)&&q.issues.length)q.status='needs_review';
   validateStandardQuestion(q,s.name);
   if(ids.has(q.question_id))throw Error('云端题目 ID 重复');
   ids.add(q.question_id);
  }
 }
 if(s.pending.length||s.removed.some(r=>!uuid.test(r.question_id)||r.status!=='merged'))throw Error('云端题库包含不支持的候选层');
 return s;
}
export function combineLayers(formal:SyncQuestion[],draft:SyncQuestion[]):SyncQuestion[]{
 const result:SyncQuestion[]=[],ids=new Set<string>(),content=new Set<string>();
 for(const [layer,questions] of [['formal',formal],['draft',draft]] as const){
  for(const q of questions){const key=identityKey(q);if(ids.has(q.question_id)||(layer!=='formal'&&content.has(key)))continue;ids.add(q.question_id);content.add(key);result.push({...q,cloud_layer:layer});}
 }
 return result;
}
