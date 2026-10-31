'use strict';
// Each revision is immutable: uploads and rollbacks commit a full state file.
// Upload retries replay durable submission/merge records;
// concurrent writers never overwrite one another.
const {HttpError,sha256}=require('./common.cjs');
const {packText}=require('./codec.cjs');
const {key,answer,releaseName,manifest,questionFile}=require('./projection.cjs');
const {buildInitialOperation,appendOperation,diffQuestionIds}=require('./operations.cjs');
const MAX_STATE_BYTES=4*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deny=(status,code,message)=>{throw new HttpError(status,code,message)};
const uploaderName=(...values)=>values.map(value=>typeof value==='string'?value.trim():'').find(value=>value&&value!=='未记录')||'star';

function createWorkflow({store,validateStandardQuestion,clock,decodeSubmission}){
 const bank=(config,id)=>{const b=config.banks.find(b=>b.bank_id===id);if(!b)deny(404,'BANK_UNKNOWN','题库不存在');return b;};
 const enabled=config=>{if(!config.syncEnabled)deny(503,'SYNC_DISABLED','云端版本同步尚未启用，本地题库仍可使用');};
 async function latest(b){return await store.readState(b.bank_id)||{format:'qbank-state-1',bank_id:b.bank_id,name:b.name,revision:0,release_version:0,formal:null,pending:[],resolved:[],batches:[],merge_history:[],updated_at:''};}
 async function atRevision(b,revision){
  if(!Number.isSafeInteger(revision)||revision<1)return null;
  return store.readStateAt(b.bank_id,revision);
 }
 async function operationFileFor(b,state){
  // The current service reads and advances the append-only pipeline sidecar.
  // Historical state files are never scanned to rebuild operation records.
  if(typeof store.readOperations!=='function'||typeof store.writeOperations!=='function'){
   throw new Error('题库流水存储未启用');
  }
  let pipeline=await store.readOperations(b.bank_id);
  if(!pipeline){
   if(state.revision>0&&!state.operation_event)throw new Error('题库流水侧车缺失，请先上传 qbank-operations-2');
   const initial=buildInitialOperation(state,{name:b.name,event:state.revision===1?state.operation_event:null});
   await store.writeOperations(initial);
   return (await store.readOperations(b.bank_id))||initial;
  }
  if(pipeline.format!=='qbank-operations-2')throw new Error('题库包含已停用的旧流水格式');
  if(pipeline.current_revision>state.revision)throw new Error('操作流水版本高于题库版本');
  if(pipeline.current_revision<state.revision){
   if(state.revision!==pipeline.current_revision+1||!state.operation_event)throw new Error('题库修订流水缺少当前操作事件');
   const next=appendOperation(pipeline,state,state.operation_event);
   await store.writeOperations(next);
   pipeline=(await store.readOperations(b.bank_id))||next;
  }
  return pipeline;
 }
 async function manifestFor(b,state){
  const operations=await operationFileFor(b,state),payload=JSON.stringify(operations);
  return manifest(state,{operations_file_sha256:sha256(payload),operations_file_bytes:Buffer.byteLength(payload),operations_file_format:operations.format});
 }
 function validateQuestion(q,name){
  try{validateStandardQuestion(q,name);}catch{deny(422,'QUESTION_INVALID','请核对题目结构、题库身份、选项和答案');}
 }
 async function commit(s,b,at=new Date(clock()).toISOString(),operationEvent=null){
  s.revision++;s.updated_at=at;
  if(operationEvent)s.operation_event={...operationEvent,revision:s.revision,operated_at:at};
  if(Buffer.byteLength(JSON.stringify(s))>MAX_STATE_BYTES)deny(413,'BANK_TOO_LARGE','当前题库超过单次同步上限，请先归档处理记录或拆分题库');
  if(!await store.createState(s))deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重新核对');
  return manifestFor(b,s);
 }
 const catalog=require('./catalog.cjs').createCatalog({store,validateStandardQuestion,clock,releaseName,manifest,
  manifestFor:async(state,bank)=>manifestFor(bank||{bank_id:state.bank_id,name:state.name},state)});
 return {
  resolve:catalog.resolve,promote:catalog.promote,
  async ensureReady(config,bankId){
   enabled(config);
   const s=await latest(bank(config,bankId));
   if(s.formal===null)deny(409,'SEED_REQUIRED','请先从桌面初始化云端正式首版');
   return s;
  },
  async read(method,path,config,auth){
   if(method!=='GET')return;
   if(path==='/v1/catalog'){enabled(config);return {banks:await Promise.all(config.banks.map(async b=>manifestFor(b,await latest(b))))};}
   const match=/^\/v1\/banks\/([0-9a-f-]{36})\/(manifest|question-file|operations-file)$/.exec(path||'');if(!match)return;
   enabled(config);const s=await latest(bank(config,match[1]));
   if(match[2]==='manifest')return manifestFor(bank(config,match[1]),s);
   if(match[2]==='question-file')return packText(JSON.stringify(questionFile(s)));
   if(match[2]==='operations-file'){
    if(!auth)return;
    const roles=auth.grants?.[match[1]]||[],canView=auth.capabilities?.includes('maintainer:manage')||(auth.desktop&&roles.includes('merge'))||roles.includes('upload')||auth.permissions?.includes('export');
    if(!canView)deny(403,'ROLE_FORBIDDEN','没有此题库的版本查看权限');
    const b=bank(config,match[1]),operations=await operationFileFor(b,s);
    return packText(JSON.stringify(operations));
   }
  },
  async mergeSubmission(config,record,delta,auth){
   const b=bank(config,delta.bank_id);
   for(let attempt=0;attempt<4;attempt++){
    const s=await latest(b);
    if(s.formal===null)deny(409,'SEED_REQUIRED','请先从桌面初始化云端正式首版');
    const previous=(s.merge_history||[]).find(m=>m.submission_id===record.submission_id);
    if(s.batches.includes(record.submission_id)){
     if(!previous)deny(502,'MERGE_RECORD_MISSING','合并记录不完整，请保留本地批次并联系管理员');
     return {manifest:await manifestFor(b,s),merged:false,duplicate:true,merge:{...previous,duplicate:true}};
    }
    const qs=delta.payload.trim().split('\n').map(JSON.parse),formal=s.formal.map(q=>({...q}));
    const resolved=[];let added=0,duplicates=0;const addedQuestionIds=[];
    for(const q of qs){
     validateQuestion(q,b.name);
     const duplicate=formal.find(existing=>existing.question_id===q.question_id||key(existing)===key(q));
     if(duplicate){
      if(key(duplicate)!==key(q)||answer(duplicate)!==answer(q))
       deny(409,'ANSWER_CONFLICT','上传题目与正式题库内容或答案冲突，未合并任何题目');
      duplicates++;resolved.push({id:`${delta.batch_id}/${q.question_id}`,question_id:q.question_id,status:'merged',target_id:duplicate.question_id,duplicate:true});
    }else{formal.push({...q,status:record.status_mode==='preserve'?q.status:'verified'});added++;addedQuestionIds.push(q.question_id);resolved.push({id:`${delta.batch_id}/${q.question_id}`,question_id:q.question_id,status:'merged',target_id:q.question_id});}
    }
    const mergedAt=new Date(clock()).toISOString();
    const uploaderAccountId=record.uploader_account_id||auth.account_id||auth.maintainer_id||auth.openid;
    const uploaderRealName=uploaderName(record.uploader_real_name,auth.real_name);
    const uploaderNickname=uploaderName(record.uploader_nickname,auth.nickname);
    const uploaderAuthType=record.uploader_auth_type||(auth.password_account?'password':'key');
    s.batches=[...(s.batches||[]),record.submission_id];s.resolved=[...(s.resolved||[]),...resolved];
    s.merge_history=[...(s.merge_history||[]),{submission_id:record.submission_id,batch_id:delta.batch_id,merged_at:mergedAt,note:record.note||null,
      question_count:qs.length,added_count:added,duplicate_count:duplicates,added_question_ids:addedQuestionIds,
      revision:s.revision+1,release_version:s.release_version,actor:sha256(auth.openid),uploader_account_id:uploaderAccountId,
      uploader_real_name:uploaderRealName,uploader_nickname:uploaderNickname,uploader_auth_type:uploaderAuthType}];
    const wasRolledBack=!!s.rollback;
    if(added){
      const previousLabel=s.release_version_label||`v${s.release_version}`;
      const nextBase=s.release_version+1,basePrefix=`v${nextBase}`;
      const states=await store.listStates(b.bank_id);
      const labels=[...states.map(item=>item.release_version_label||`v${item.release_version}`),...(s.merge_history||[]).map(item=>item.release_version_label||`v${item.release_version}`),previousLabel];
      const suffixes=labels.filter(label=>label===basePrefix||label.startsWith(`${basePrefix}.`)).map(label=>label===basePrefix?0:Number(label.slice(basePrefix.length+1))).filter(Number.isSafeInteger);
      const nextLabel=wasRolledBack&&suffixes.length?`${basePrefix}.${Math.max(...suffixes)+1}`:basePrefix;
      s.formal=formal;s.release_version=nextBase;s.release_version_label=nextLabel;s.merged_at=mergedAt;s.release_id=sha256(JSON.stringify(formal));
      s.release_name=releaseName(mergedAt,s.name,'合并',nextLabel.slice(1),s.bank_id,s.release_id);
      s.rollback=null;s.rollback_at=null;s.merge_history.at(-1).release_version=s.release_version;s.merge_history.at(-1).release_version_label=nextLabel;}
    // A duplicate-only upload after a rollback is still a formal merge. It
    // must clear the rollback marker so later records cannot inherit the old
    // pointer semantics or be misclassified as another rollback.
    if(!added&&wasRolledBack){
     s.rollback=null;s.rollback_at=null;
     s.release_name=releaseName(mergedAt,s.name,'合并',s.release_version,s.bank_id,s.release_id||sha256(JSON.stringify(s.formal)));
    }
    s.merge_history.at(-1).release_name=s.release_name;
    try{
     const result=await commit(s,b,mergedAt,{kind:'merge',operator:{account_id:uploaderAccountId,real_name:uploaderRealName,nickname:uploaderNickname,auth_type:uploaderAuthType},
      note:record.note||null,batch_id:delta.batch_id,question_count:qs.length,duplicate_count:duplicates,added:addedQuestionIds,revised:[],removed:[]});
     return {manifest:result,merged:added>0,duplicate:false,merge:s.merge_history.at(-1)};
    }catch(e){if(e.code!=='REVISION_CONFLICT')throw e;}
   }
   deny(409,'REVISION_CONFLICT','其他维护者正在更新，请重试同一上传批次');
  },
  async write(method,path,body,config,auth){
   enabled(config);
   const match=new RegExp('^/v1/banks/([0-9a-f-]{36})/(seed|rollback)$').exec(path);
   const id=match[1],action=match[2];
   const b=bank(config,id),roles=auth.grants[id]||[],globalAdmin=auth.capabilities?.includes('maintainer:manage');
   if(!globalAdmin&&!roles.includes('merge'))deny(403,'ROLE_FORBIDDEN','没有此题库的合并发布权限');
   const s=await latest(b);
   if(method!=='POST')deny(405,'METHOD_NOT_ALLOWED','不支持此请求方法');
   const operation=body?.operation_id,operationHash=sha256(JSON.stringify({actor:auth.openid,action,body}));
   if(operation){
    if(!UUID.test(operation))deny(422,'OPERATION_INVALID','合并任务 ID 无效');
    const old=(s.operations||[]).find(o=>o.id===operation);
    if(old){
     if(old.hash!==operationHash)deny(409,'OPERATION_CONFLICT','任务 ID 已用于不同内容');
     // Rebuild the manifest from the immutable full state. Every current
     // revision exposes the append-only operation-file digest.
     return manifestFor(b,s);
    }
   }
   if(!body||body.base_revision!==s.revision)deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重试');
   if(action==='rollback'){
    if(!operation)deny(422,'OPERATION_REQUIRED','回退任务必须提供操作 ID');
    if(!Number.isSafeInteger(body.target_revision)||body.target_revision<1||body.target_revision>=s.revision)
      deny(422,'ROLLBACK_INVALID','请选择较早的题库版本');
    const rollbackNote=typeof body.note==='string'?body.note.trim():null;
    if(rollbackNote&&rollbackNote.length>500)deny(422,'ROLLBACK_INVALID','回退备注不能超过 500 字');
    const target=await atRevision(b,body.target_revision);
    if(!target)deny(404,'VERSION_MISSING','目标版本不存在或已损坏');
    if(target.formal===null)deny(409,'SEED_REQUIRED','目标版本尚未形成正式题库');
    // The bank's current name belongs to its identity, even when restoring
    // question content from a version created before a rename.
    const restored=structuredClone(target.formal).map(q=>({...q,bank:s.name})),changes=diffQuestionIds(s.formal,restored);
    const rolledAt=new Date(clock()).toISOString(),releaseId=target.name===s.name&&target.release_id?target.release_id:sha256(JSON.stringify(restored));
    s.formal=restored;s.pending=[];s.resolved=structuredClone(target.resolved||[]);s.batches=structuredClone(target.batches||[]);s.merge_history=structuredClone(target.merge_history||[]);s.seed_uploader_account_id=null;s.seed_uploader_real_name=null;
    s.release_version=target.release_version;s.release_version_label=target.release_version_label||`v${target.release_version}`;s.merged_at=target.merged_at||rolledAt;s.release_id=releaseId;
    s.release_name=releaseName(rolledAt,s.name,'回退',s.release_version,s.bank_id,releaseId);
    s.rollback={target_revision:target.revision,from_revision:s.revision,rolled_back_at:rolledAt,actor:sha256(auth.openid)};s.rollback_at=rolledAt;
    const fromRevision=s.revision,nextRevision=fromRevision+1;
    const projectedResult=manifest({...s,revision:nextRevision,updated_at:rolledAt});
    const operationRecord={id:operation,hash:operationHash,result:projectedResult};
    s.revision=nextRevision;s.updated_at=rolledAt;
    s.operation_event={revision:nextRevision,operated_at:rolledAt,kind:'rollback',operator:{account_id:auth.account_id||auth.maintainer_id||auth.openid,
      real_name:uploaderName(auth.real_name),nickname:uploaderName(auth.nickname),auth_type:auth.password_account?'password':'key'},note:rollbackNote||null,
      added:changes.added,revised:changes.revised,removed:changes.removed,question_count:restored.length,duplicate_count:0};
    s.operations=[...(s.operations||[]),operationRecord];
    if(!await store.createState(s)){
     const latestState=await latest(b),previous=(latestState.operations||[]).find(o=>o.id===operation);
     if(previous){if(previous.hash!==operationHash)deny(409,'OPERATION_CONFLICT','任务 ID 已用于不同内容');return manifestFor(b,latestState);}
     deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重新核对');
    }
    return manifestFor(b,s);
   }
   if(action!=='seed')deny(405,'METHOD_NOT_ALLOWED','不支持此请求方法');
   if(!auth.capabilities?.includes('cloud_bank:create'))deny(403,'CREATE_FORBIDDEN','首版初始化需要桌面最高权限');
   if(s.formal!==null)deny(409,'ALREADY_INITIALIZED','正式题库已初始化，请通过上传直接合并后续题目');
   if(!Array.isArray(body.questions)||!body.questions.length||body.questions.length>10000)deny(422,'SEED_INVALID','初始正式题库须包含 1 至 10000 题');
   const ids=new Set();for(const q of body.questions){validateQuestion(q,b.name);if(ids.has(q.question_id))deny(422,'DUPLICATE_ID','正式题库含重复 ID');ids.add(q.question_id);}
   s.formal=body.questions;s.release_version=1;s.release_version_label='v1';
   s.seed_uploader_account_id=auth.account_id||auth.maintainer_id||auth.openid;
   s.seed_uploader_real_name=uploaderName(auth.real_name);
   const committedAt=new Date(clock()).toISOString();s.merged_at=committedAt;s.release_id=sha256(JSON.stringify(s.formal));
   s.release_name=releaseName(committedAt,s.name,'初建',s.release_version,s.bank_id,s.release_id);
   if(operation){s.operations=s.operations||[];const projectedResult=manifest({...s,revision:s.revision+1,updated_at:committedAt});s.operations.push({id:operation,hash:operationHash,result:projectedResult});}
   return commit(s,b,committedAt,{kind:'seed',operator:{account_id:auth.account_id||auth.maintainer_id||auth.openid,real_name:uploaderName(auth.real_name),nickname:uploaderName(auth.nickname),auth_type:auth.password_account?'password':'key'},
    note:'正式题库首版初始化',question_count:body.questions.length,duplicate_count:0,added:body.questions.map(question=>question.question_id),revised:[],removed:[]});
  }
 };
}
module.exports={createWorkflow,MAX_STATE_BYTES};
