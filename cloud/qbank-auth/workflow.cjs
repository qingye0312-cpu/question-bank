'use strict';
// Each revision is immutable: uploads commit a full state and rollbacks commit
// a compact reference. Upload retries replay durable submission/merge records;
// concurrent writers never overwrite one another.
const {HttpError,sha256}=require('./common.cjs');
const {packText}=require('./codec.cjs');
const {key,answer,releaseName,projected,manifest}=require('./projection.cjs');
const MAX_STATE_BYTES=4*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deny=(status,code,message)=>{throw new HttpError(status,code,message)};

function createWorkflow({store,validateStandardQuestion,clock}){
 const bank=(config,id)=>{const b=config.banks.find(b=>b.bank_id===id);if(!b)deny(404,'BANK_UNKNOWN','题库不存在');return b;};
 const enabled=config=>{if(!config.syncEnabled)deny(503,'SYNC_DISABLED','云端版本同步尚未启用，本地题库仍可使用');};
 async function latest(b){return await store.readState(b.bank_id)||{format:'qbank-state-1',bank_id:b.bank_id,name:b.name,revision:0,release_version:0,formal:null,pending:[],resolved:[],batches:[],merge_history:[],updated_at:''};}
 async function atRevision(b,revision){
  if(!Number.isSafeInteger(revision)||revision<1)return null;
  return store.readStateAt(b.bank_id,revision);
 }
 async function history(b){
  const states=await store.listStates(b.bank_id);
  return states.map(s=>{
   const merge=(s.merge_history||[]).find(m=>m.revision===s.revision);
   return {revision:s.revision,release_version:s.release_version,updated_at:s.updated_at,merged_at:s.merged_at||null,
    release_name:s.release_name||null,release_id:s.release_id||null,rollback_at:s.rollback_at||null,
    rollback_of:s.rollback?.target_revision||null,merge_count:Array.isArray(s.merge_history)?s.merge_history.length:0,
    uploader_account_id:merge?.uploader_account_id||null,uploader_nickname:merge?.uploader_nickname||null,
    uploader_auth_type:merge?.uploader_auth_type||null};
  });
 }
 function validateQuestion(q,name){
  try{validateStandardQuestion(q,name);}catch{deny(422,'QUESTION_INVALID','请核对题目结构、题库身份、选项和答案');}
 }
 async function commit(s,at=new Date(clock()).toISOString()){
  s.revision++;s.updated_at=at;
  if(Buffer.byteLength(JSON.stringify(s))>MAX_STATE_BYTES)deny(413,'BANK_TOO_LARGE','当前题库超过单次同步上限，请先归档处理记录或拆分题库');
  if(!await store.createState(s))deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重新核对');
  return manifest(s);
 }
 const catalog=require('./catalog.cjs').createCatalog({store,validateStandardQuestion,clock,releaseName,manifest});
 return {
  resolve:catalog.resolve,promote:catalog.promote,
  async ensureReady(config,bankId){
   enabled(config);
   const s=await latest(bank(config,bankId));
   if(s.formal===null)deny(409,'SEED_REQUIRED','请先从桌面初始化云端正式首版');
   return s;
  },
  async read(method,path,config){
   if(method!=='GET')return;
   if(path==='/v1/catalog'){enabled(config);return {banks:await Promise.all(config.banks.map(async b=>manifest(await latest(b))))};}
   const match=/^\/v1\/banks\/([0-9a-f-]{36})\/(manifest|snapshot-file)$/.exec(path||'');if(!match)return;
   enabled(config);const s=await latest(bank(config,match[1]));
   if(match[2]==='manifest')return manifest(s);
   const payload=JSON.stringify(projected(s));return packText(payload);
  },
  async mergeSubmission(config,record,delta,auth){
   const b=bank(config,delta.bank_id);
   for(let attempt=0;attempt<4;attempt++){
    const s=await latest(b);
    if(s.formal===null)deny(409,'SEED_REQUIRED','请先从桌面初始化云端正式首版');
    const previous=(s.merge_history||[]).find(m=>m.submission_id===record.submission_id);
    if(s.batches.includes(record.submission_id)){
     if(!previous)deny(502,'MERGE_RECORD_MISSING','合并记录不完整，请保留本地批次并联系管理员');
     return {manifest:manifest(s),merged:false,duplicate:true,merge:{...previous,duplicate:true}};
    }
    const qs=delta.payload.trim().split('\n').map(JSON.parse),formal=s.formal.map(q=>({...q}));
    const resolved=[];let added=0,duplicates=0;
    for(const q of qs){
     validateQuestion(q,b.name);
     const duplicate=formal.find(existing=>existing.question_id===q.question_id||key(existing)===key(q));
     if(duplicate){
      if(key(duplicate)!==key(q)||answer(duplicate)!==answer(q))
       deny(409,'ANSWER_CONFLICT','上传题目与正式题库内容或答案冲突，未合并任何题目');
      duplicates++;resolved.push({id:`${delta.batch_id}/${q.question_id}`,question_id:q.question_id,status:'merged',target_id:duplicate.question_id,duplicate:true});
     }else{formal.push({...q,status:'verified'});added++;resolved.push({id:`${delta.batch_id}/${q.question_id}`,question_id:q.question_id,status:'merged',target_id:q.question_id});}
    }
    const mergedAt=new Date(clock()).toISOString();
    const uploaderAccountId=record.uploader_account_id||auth.account_id||auth.maintainer_id||auth.openid;
    const uploaderNickname=record.uploader_nickname||(typeof auth.nickname==='string'&&auth.nickname.trim()
      ?auth.nickname.trim():auth.maintainer_id?'最高权限维护者 '+auth.maintainer_id:uploaderAccountId);
    const uploaderAuthType=record.uploader_auth_type||(auth.password_account?'password':'key');
    s.batches=[...(s.batches||[]),record.submission_id];s.resolved=[...(s.resolved||[]),...resolved];
    s.merge_history=[...(s.merge_history||[]),{submission_id:record.submission_id,batch_id:delta.batch_id,merged_at:mergedAt,
      question_count:qs.length,added_count:added,duplicate_count:duplicates,revision:s.revision+1,release_version:s.release_version,
      actor:sha256(auth.openid),uploader_account_id:uploaderAccountId,uploader_nickname:uploaderNickname,uploader_auth_type:uploaderAuthType}];
    if(added){s.formal=formal;s.release_version++;s.merged_at=mergedAt;s.release_id=sha256(JSON.stringify(formal));
      s.release_name=releaseName(mergedAt,s.name,'合并',s.release_version,s.bank_id,s.release_id);
      s.merge_history.at(-1).release_version=s.release_version;}
    s.merge_history.at(-1).release_name=s.release_name;
    try{
     const result=await commit(s,mergedAt);
     return {manifest:result,merged:added>0,duplicate:false,merge:s.merge_history.at(-1)};
    }catch(e){if(e.code!=='REVISION_CONFLICT')throw e;}
   }
   deny(409,'REVISION_CONFLICT','其他维护者正在更新，请重试同一上传批次');
  },
  async write(method,path,body,config,auth){
   enabled(config);
   const [,id,action]=new RegExp('^/v1/banks/([0-9a-f-]{36})/(seed|history|rollback)$').exec(path);
   const b=bank(config,id),roles=auth.grants[id]||[];
   if(!auth.desktop||!roles.includes('merge'))deny(403,'ROLE_FORBIDDEN','没有此题库的合并发布权限');
   const s=await latest(b);
   if(action==='history'&&method==='GET')return {current_revision:s.revision,release_version:s.release_version,versions:await history(b)};
   if(method!=='POST')deny(405,'METHOD_NOT_ALLOWED','不支持此请求方法');
   const operation=body?.operation_id,operationHash=sha256(JSON.stringify({actor:auth.openid,action,body}));
   if(operation){
    if(!UUID.test(operation))deny(422,'OPERATION_INVALID','合并任务 ID 无效');
    const old=(s.operations||[]).find(o=>o.id===operation);
    if(old){if(old.hash!==operationHash)deny(409,'OPERATION_CONFLICT','任务 ID 已用于不同内容');if(action==='rollback')await store.finalizeRollback?.(b.bank_id,old.result.revision);return old.result;}
   }
   if(!body||body.base_revision!==s.revision)deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重试');
   if(action==='rollback'){
    if(!operation)deny(422,'OPERATION_REQUIRED','回退任务必须提供操作 ID');
    if(!Number.isSafeInteger(body.target_revision)||body.target_revision<1||body.target_revision>=s.revision)
      deny(422,'ROLLBACK_INVALID','请选择较早的题库版本');
    const target=await atRevision(b,body.target_revision);
    if(!target)deny(404,'VERSION_MISSING','目标版本不存在或已损坏');
    if(target.formal===null)deny(409,'SEED_REQUIRED','目标版本尚未形成正式题库');
    // The bank's current name belongs to its identity, even when restoring
    // question content from a version created before a rename.
    const restored=structuredClone(target.formal).map(q=>({...q,bank:s.name}));
    const rolledAt=new Date(clock()).toISOString(),releaseId=target.name===s.name&&target.release_id?target.release_id:sha256(JSON.stringify(restored));
    s.formal=restored;s.pending=[];s.resolved=structuredClone(target.resolved||[]);
    s.release_version=target.release_version;s.merged_at=target.merged_at||rolledAt;s.release_id=releaseId;
    s.release_name=releaseName(rolledAt,s.name,'回退',s.release_version,s.bank_id,releaseId);
    s.rollback={target_revision:target.revision,from_revision:s.revision,rolled_back_at:rolledAt,actor:sha256(auth.openid)};s.rollback_at=rolledAt;
    const fromRevision=s.revision,nextRevision=fromRevision+1;
    const projectedResult=manifest({...s,revision:nextRevision,updated_at:rolledAt});
    const operationRecord={id:operation,hash:operationHash,result:projectedResult};
    s.revision=nextRevision;s.updated_at=rolledAt;
    s.operations=[...(s.operations||[]),operationRecord];
    if(!await store.createRollback(s,target.revision,operationRecord)){
     const latestState=await latest(b),previous=(latestState.operations||[]).find(o=>o.id===operation);
     if(previous){if(previous.hash!==operationHash)deny(409,'OPERATION_CONFLICT','任务 ID 已用于不同内容');return previous.result;}
     deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重新核对');
    }
    return projectedResult;
   }
   if(action!=='seed')deny(405,'METHOD_NOT_ALLOWED','不支持此请求方法');
   if(!auth.capabilities?.includes('cloud_bank:create'))deny(403,'CREATE_FORBIDDEN','首版初始化需要桌面最高权限');
   if(s.formal!==null)deny(409,'ALREADY_INITIALIZED','正式题库已初始化，请通过上传直接合并后续题目');
   if(!Array.isArray(body.questions)||!body.questions.length||body.questions.length>10000)deny(422,'SEED_INVALID','初始正式题库须包含 1 至 10000 题');
   const ids=new Set();for(const q of body.questions){validateQuestion(q,b.name);if(ids.has(q.question_id))deny(422,'DUPLICATE_ID','正式题库含重复 ID');ids.add(q.question_id);}
   s.formal=body.questions;s.release_version=1;
   const committedAt=new Date(clock()).toISOString();s.merged_at=committedAt;s.release_id=sha256(JSON.stringify(s.formal));
   s.release_name=releaseName(committedAt,s.name,'初建',s.release_version,s.bank_id,s.release_id);
   if(operation){s.operations=s.operations||[];const projectedResult=manifest({...s,revision:s.revision+1,updated_at:committedAt});s.operations.push({id:operation,hash:operationHash,result:projectedResult});}
   return commit(s,committedAt);
  }
 };
}
module.exports={createWorkflow,MAX_STATE_BYTES};
