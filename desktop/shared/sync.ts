import {unpackText,CLOUD_FILE_FORMAT} from './codec.ts';
import {validTime,validateStandardQuestion,sha256,identityKey,type IntakeQuestion} from './intake.ts';

export type SyncQuestion=Omit<IntakeQuestion,'answer'> & {answer:string[]|boolean|null; cloud_layer?:string};
export type CloudManifest={
 bank_id:string;name:string;revision:number;release_version:number;release_version_label?:string|null;
 question_count:number;minimum_client:string;updated_at:string;
 question_file_sha256:string;question_file_bytes:number;question_file_format:'qbank-question-bank-1';
 operations_file_sha256:string;operations_file_bytes:number;operations_file_format:'qbank-operations-2';
 merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;
};
export type CloudQuestionFile={format:'qbank-question-bank-1';bank_id:string;name:string;revision:number;release_version:number;release_version_label?:string|null;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;questions:SyncQuestion[]|null};
export type CloudOperationOperator={account_id?:string|null;real_name?:string|null;nickname?:string|null;auth_type?:string|null};
export type CloudOperationRevision={revision:number;kind:'bootstrap'|'seed'|'merge'|'rollback'|'state';release_version:number;release_version_label?:string|null;operated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;batch_id?:string|null;note?:string|null;question_count:number;added_count:number;changed_count:number;duplicate_count:number;revised_count:number;removed_count:number;rollback_of?:number|null;operator:CloudOperationOperator;added:string[];revised:string[];removed:string[]};
export type CloudOperationsFile={format:'qbank-operations-2';bank_id:string;name:string;current_revision:number;current_release_version:number;current_release_version_label?:string|null;updated_at:string;question_index:Record<string,number>;revisions:CloudOperationRevision[]};

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const validUploader=(value:unknown)=>{if(!value||typeof value!=='object')return false;const item=value as Record<string,unknown>;return ['account_id','real_name','nickname','auth_type'].every(key=>item[key]==null||typeof item[key]==='string');};

export function readManifest(value:unknown):CloudManifest{
 const m=value as CloudManifest;
 if(!m||!uuid.test(m.bank_id)||typeof m.name!=='string'||!m.name.trim()||m.name.length>100||!nonnegative(m.revision)||!nonnegative(m.release_version)
  ||!nonnegative(m.question_count)||m.question_count>20000||typeof m.minimum_client!=='string'||!/^(?:\d+)\.(?:\d+)\.(?:\d+)$/.test(m.minimum_client)
  ||typeof m.updated_at!=='string'||(m.revision>0&&!validTime(m.updated_at))
  ||typeof m.question_file_sha256!=='string'||!/^[a-f0-9]{64}$/.test(m.question_file_sha256)||!nonnegative(m.question_file_bytes)||m.question_file_bytes>4194304||m.question_file_format!=='qbank-question-bank-1'
  ||typeof m.operations_file_sha256!=='string'||!/^[a-f0-9]{64}$/.test(m.operations_file_sha256)||!nonnegative(m.operations_file_bytes)||m.operations_file_bytes>4194304||m.operations_file_format!=='qbank-operations-2')throw Error('云端版本清单无效，继续使用已缓存题库');
 const needed=m.minimum_client.split('.').map(Number),current=[0,2,7];for(let i=0;i<3;i++){if(needed[i]>current[i])throw Error('此题库需要更新客户端，请先升级程序');if(needed[i]<current[i])break;}
 const validReleaseName=m.release_name==null||(typeof m.release_name==='string'&&m.release_name.length<=220&&!/[\\/:*?"<>|\x00-\x1f]/.test(m.release_name));
 const validReleaseLabel=m.release_version_label==null||(typeof m.release_version_label==='string'&&/^v\d+(?:\.\d+)?$/.test(m.release_version_label));
 if(m.merged_at!=null&&!validTime(m.merged_at)||m.rollback_at!=null&&!validTime(m.rollback_at)||m.rollback_of!=null&&(!Number.isSafeInteger(m.rollback_of)||m.rollback_of<1)||m.release_id!=null&&!/^[a-f0-9]{64}$/.test(m.release_id)||!validReleaseName||!validReleaseLabel)throw Error('云端结果名称或时间无效');
 return m;
}

function filePayload(value:unknown):{payload:string;sha256:string}{const v=value as {format?:string;sha256?:string};if(!v||v.format!==CLOUD_FILE_FORMAT||typeof v.sha256!=='string')throw Error('云端文件封装无效');return {payload:unpackText(v),sha256:v.sha256};}
function byteLength(value:string){let bytes=0;for(const c of value){const p=c.codePointAt(0)!;bytes+=p<128?1:p<2048?2:p<65536?3:4;}return bytes;}
export function questionFilePath(m:CloudManifest){return `/v1/banks/${m.bank_id}/question-file`;}
export function operationsFilePath(m:CloudManifest){return `/v1/banks/${m.bank_id}/operations-file`;}
export function questionFilePayload(value:unknown,m:CloudManifest):{payload:string;sha256:string}{const w=filePayload(value);if(w.sha256!==m.question_file_sha256||sha256(w.payload)!==w.sha256)throw Error('云端题库摘要校验失败');if(byteLength(w.payload)!==m.question_file_bytes)throw Error('云端题库大小不一致');return w;}
export function operationsFilePayload(value:unknown,m:CloudManifest):{payload:string;sha256:string}{const w=filePayload(value);if(w.sha256!==m.operations_file_sha256||sha256(w.payload)!==w.sha256)throw Error('云端修订记录摘要校验失败');if(byteLength(w.payload)!==m.operations_file_bytes)throw Error('云端修订记录大小不一致');return w;}

export function readQuestionFile(value:unknown,m:CloudManifest):CloudQuestionFile{
 const w=questionFilePayload(value,m);if(w.payload.length>4194304)throw Error('云端题库文件过大');
 const file=JSON.parse(w.payload) as CloudQuestionFile;
 if(file.format!=='qbank-question-bank-1'||file.bank_id!==m.bank_id||file.name!==m.name||file.revision!==m.revision||file.release_version!==m.release_version||file.release_version_label!==m.release_version_label||!Array.isArray(file.questions)||file.questions.length>20000||typeof file.updated_at!=='string'||file.updated_at!==m.updated_at||!validTime(file.updated_at)||file.merged_at!==m.merged_at||file.release_name!==m.release_name||file.release_id!==m.release_id||file.rollback_at!==m.rollback_at||file.rollback_of!==m.rollback_of)throw Error('云端题库身份或结构无效');
 if(file.questions.length!==m.question_count)throw Error('云端题库数量与版本清单不一致，保留本地题库');
 const ids=new Set<string>();for(const question of file.questions){if(question&&question.status==='verified'&&question.type!=='programming'&&question.answer===null&&Array.isArray(question.issues)&&question.issues.length)question.status='needs_review';validateStandardQuestion(question,file.name);if(ids.has(question.question_id))throw Error('云端题目 ID 重复');ids.add(question.question_id);}return file;
}

function idList(value:unknown):value is string[]{if(!Array.isArray(value))return false;const seen=new Set<string>();for(const item of value){if(typeof item!=='string'||!uuid.test(item)||seen.has(item))return false;seen.add(item);}return true;}
export function readOperationsFile(value:unknown,m:CloudManifest):CloudOperationsFile{
 const w=operationsFilePayload(value,m);if(w.payload.length>4194304)throw Error('云端修订记录过大');const file=JSON.parse(w.payload) as CloudOperationsFile;
 if(file.format!=='qbank-operations-2'||file.bank_id!==m.bank_id||file.name!==m.name||file.current_revision!==m.revision||file.current_release_version!==m.release_version||file.current_release_version_label!==m.release_version_label||typeof file.updated_at!=='string'||file.updated_at!==m.updated_at||file.current_revision===0&&file.updated_at!==''||file.current_revision>0&&!validTime(file.updated_at)||!file.question_index||typeof file.question_index!=='object'||Array.isArray(file.question_index)||Object.keys(file.question_index).length>20000||!Array.isArray(file.revisions)||file.revisions.length>10000)throw Error('云端修订流水身份或结构无效');
 for(const [questionId,lastRevision] of Object.entries(file.question_index))if(!uuid.test(questionId)||!Number.isSafeInteger(lastRevision)||lastRevision<1||lastRevision>file.current_revision)throw Error('云端当前题目索引无效');
 const revisions=new Set<number>();let previousRevision=0;
 for(const revision of file.revisions){
  if(!revision||!Number.isSafeInteger(revision.revision)||revision.revision<1||revision.revision>file.current_revision||revision.revision<=previousRevision||revisions.has(revision.revision)||!['bootstrap','seed','merge','rollback','state'].includes(revision.kind)||!nonnegative(revision.release_version)||!nonnegative(revision.question_count)||!nonnegative(revision.added_count)||!nonnegative(revision.changed_count)||!nonnegative(revision.duplicate_count)||!nonnegative(revision.revised_count)||!nonnegative(revision.removed_count)||!idList(revision.added)||!idList(revision.revised)||!idList(revision.removed)||revision.added_count!==revision.added.length||revision.revised_count!==revision.revised.length||revision.removed_count!==revision.removed.length||revision.changed_count!==revision.added_count+revision.revised_count||!validUploader(revision.operator)||typeof revision.operated_at!=='string'||!validTime(revision.operated_at)||revision.merged_at!=null&&!validTime(revision.merged_at)||revision.release_version_label!=null&&!/^v\d+(?:\.\d+)?$/.test(revision.release_version_label)||revision.rollback_of!=null&&!nonnegative(revision.rollback_of)||revision.note!=null&&(typeof revision.note!=='string'||revision.note.length>500))throw Error('云端修订流水记录无效');
  const overlap=new Set(revision.added);for(const questionId of [...revision.revised,...revision.removed])if(overlap.has(questionId))throw Error('云端修订流水动作重复');else overlap.add(questionId);revisions.add(revision.revision);previousRevision=revision.revision;
 }
 if(file.current_revision>0&&!revisions.has(file.current_revision))throw Error('云端修订流水缺少当前修订');return file;
}

export function combineLayers(formal:SyncQuestion[],draft:SyncQuestion[]):SyncQuestion[]{const result:SyncQuestion[]=[],ids=new Set<string>(),content=new Set<string>();for(const [layer,questions] of [['formal',formal],['draft',draft]] as const)for(const q of questions){const key=identityKey(q);if(ids.has(q.question_id)||(layer!=='formal'&&content.has(key)))continue;ids.add(q.question_id);content.add(key);result.push({...q,cloud_layer:layer});}return result;}
