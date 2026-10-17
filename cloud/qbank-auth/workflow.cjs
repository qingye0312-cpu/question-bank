'use strict';
// One immutable state object is the commit point for both the formal release and
// its pending overlay. Contending writers create the same revision key: only one
// succeeds. No last-writer-wins manifest and no separate removal/download gap.
const {HttpError,sha256}=require('./service.cjs');
const MAX_STATE_BYTES=4*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const deny=(status,code,message)=>{throw new HttpError(status,code,message)};
const clean=s=>s.replace(/\r\n?/g,'\n').trim();
const key=q=>{const options=q.options.map(o=>clean(o.content));if(new Set(options).size===options.length)options.sort();return JSON.stringify([q.type,clean(q.stem),options]);};
const answer=q=>{if(!Array.isArray(q.answer))return JSON.stringify(q.answer);const repeated=new Set(q.options.map(o=>clean(o.content))).size!==q.options.length;return JSON.stringify(q.answer.map(k=>repeated?k:clean(q.options.find(o=>o.key===k)?.content||'')).sort());};
const safeQuestion=q=>{
 const sources=q.sources.filter(s=>s.kind==='model_reply'&&s.model&&typeof s.model.name==='string'&&typeof s.model.version==='string').map(s=>({kind:'model_reply',model:{name:s.model.name,version:s.model.version,version_source:['user','platform','unknown'].includes(s.model.version_source)?s.model.version_source:'unknown'},answer_origin:'inferred'}));
 if(!sources.length&&q.status==='needs_review')sources.push({kind:'published_legacy'});
 const model=sources.find(s=>s.model)?.model;
 return {...q,sources,source_note:model?`原始模型 · ${model.name} / ${model.version}`:'正式题库来源',extensions:undefined};
};
function createWorkflow({store,validateStandardQuestion,clock}){
 const bank=(config,id)=>{const b=config.banks.find(b=>b.bank_id===id);if(!b)deny(404,'BANK_UNKNOWN','题库不存在');return b;};
 const enabled=config=>{if(!config.syncEnabled)deny(503,'SYNC_DISABLED','云端版本同步尚未启用，本地题库仍可使用');};
 async function latest(b){return await store.readState(b.bank_id)||{format:'qbank-state-1',bank_id:b.bank_id,name:b.name,revision:0,release_version:0,formal:null,pending:[],resolved:[],batches:[],updated_at:''};}
 function validateQuestion(q,name,legacy=false){
  try{validateStandardQuestion(q,name,legacy);}catch{deny(422,'QUESTION_INVALID','请核对题目结构、题库身份、选项和答案');}
 }

 function projected(s){return {format:'qbank-snapshot-1',bank_id:s.bank_id,name:s.name,revision:s.revision,release_version:s.release_version,
   updated_at:s.updated_at,formal:s.formal===null?null:s.formal.map(safeQuestion),pending:[...new Map(s.pending.map(p=>[p.question.question_id,safeQuestion({...p.question,status:'unreviewed'})])).values()],
   removed:s.resolved.map(r=>({question_id:r.question_id,status:r.status}))};}
 function manifest(s){const payload=JSON.stringify(projected(s));return {bank_id:s.bank_id,name:s.name,revision:s.revision,release_version:s.release_version,
   sha256:sha256(payload),bytes:Buffer.byteLength(payload),minimum_client:'0.2.7',updated_at:s.updated_at};}
 async function commit(s){s.revision++;s.updated_at=new Date(clock()).toISOString();
  if(Buffer.byteLength(JSON.stringify(s))>MAX_STATE_BYTES)deny(413,'BANK_TOO_LARGE','当前题库超过单次同步上限，请先归档处理记录或拆分题库');
  if(!await store.createState(s))deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重新核对');return manifest(s);
 }
 return {
  async read(method,path,config){
   if(method!=='GET')return;
   if(path==='/v1/catalog'){enabled(config);return {banks:await Promise.all(config.banks.map(async b=>manifest(await latest(b))))};}
   const match=/^\/v1\/banks\/([0-9a-f-]{36})\/(manifest|snapshot)$/.exec(path||'');if(!match)return;
   enabled(config);const s=await latest(bank(config,match[1]));
   if(match[2]==='manifest')return manifest(s);
   const payload=JSON.stringify(projected(s));return {payload,sha256:sha256(payload)};
  },
  async register(config,record,delta){
   const b=bank(config,delta.bank_id);
   // Acknowledged registrations are replayed safely after a crash between the
   // private receipt and public state commit. Never republish a resolved batch.
   for(let attempt=0;attempt<4;attempt++){
    const s=await latest(b);if(s.batches.includes(record.submission_id))return;
    const qs=delta.payload.trim().split('\n').map(JSON.parse);
    for(const q of qs){validateQuestion(q,b.name);s.pending.push({id:`${delta.batch_id}/${q.question_id}`,question:q,decision:'pending'});}
    s.batches.push(record.submission_id);
    try{await commit(s);return;}catch(e){if(e.code!=='REVISION_CONFLICT')throw e;}
   }deny(409,'REVISION_CONFLICT','其他维护者正在更新，请重试同一上传批次');
  },
  async write(method,path,body,config,auth){
   enabled(config);const [,id,action]=/^\/v1\/banks\/([0-9a-f-]{36})\/(review|publish|seed|candidates)$/.exec(path);
   const b=bank(config,id),roles=auth.grants[id]||[];
   const role=['publish','seed'].includes(action)?'publish':'review';
   if(!auth.desktop||!(action==='candidates'?roles.includes('review')||roles.includes('publish'):roles.includes(role)))deny(403,'ROLE_FORBIDDEN',`没有此题库的${role==='publish'?'发布':'审核'}权限`);
   const s=await latest(b);
   if(action==='candidates'&&method==='GET')return {revision:s.revision,release_version:s.release_version,candidates:s.pending,formal:s.formal};
   if(method!=='POST')deny(405,'METHOD_NOT_ALLOWED','不支持此请求方法');
   if(!body||body.base_revision!==s.revision)deny(409,'REVISION_CONFLICT','云端题库已更新，请刷新后重新核对');
   if(action==='seed'){
    if(s.formal!==null)deny(409,'ALREADY_INITIALIZED','正式题库已初始化，请通过候选审核发布后续题目');
    if(!Array.isArray(body.questions)||!body.questions.length||body.questions.length>10000)deny(422,'SEED_INVALID','初始正式题库须包含 1 至 10000 题');
    const ids=new Set();for(const q of body.questions){validateQuestion(q,b.name,true);if(ids.has(q.question_id))deny(422,'DUPLICATE_ID','正式题库含重复 ID');ids.add(q.question_id);}
    s.formal=body.questions;s.release_version=1;
   }else if(action==='review'){
    if(!['accept','reject'].includes(body.decision)||typeof body.note!=='string'||!body.note.trim()||body.note.length>1000)deny(422,'REVIEW_INVALID','请选择审核决定并填写核对说明');
    const p=s.pending.find(p=>p.id===body.candidate_id);if(!p)deny(404,'CANDIDATE_MISSING','候选题已处理，请刷新');
    if(body.decision==='accept'){
     if(body.question){validateQuestion(body.question,b.name);if(body.question.question_id!==p.question.question_id)deny(422,'QUESTION_INVALID','审核不能替换题目 ID');p.question=body.question;}
     p.question.status='verified';p.decision='accepted';p.note=body.note;p.reviewer=sha256(auth.openid);
    }else{s.pending=s.pending.filter(v=>v!==p);s.resolved.push({id:p.id,question_id:p.question.question_id,status:'rejected',note:body.note,actor:sha256(auth.openid)});}
   }else if(action==='publish'){
    if(s.formal===null)deny(409,'SEED_REQUIRED','请先从桌面初始化正式题库');
    if(body.release_version!==s.release_version)deny(409,'RELEASE_CONFLICT','正式版本已经变化，请重新比对');
    if(!Array.isArray(body.candidate_ids)||!body.candidate_ids.length||new Set(body.candidate_ids).size!==body.candidate_ids.length)deny(422,'SELECTION_REQUIRED','请选择已审核题目');
    const picked=body.candidate_ids.map(id=>s.pending.find(p=>p.id===id));if(picked.some(p=>!p||p.decision!=='accepted'))deny(409,'REVIEW_REQUIRED','只能发布已通过审核的候选题');
    for(const p of picked){const duplicate=s.formal.find(q=>q.question_id===p.question.question_id||key(q)===key(p.question));
     if(duplicate&&(key(duplicate)!==key(p.question)||answer(duplicate)!==answer(p.question)))deny(409,'ANSWER_CONFLICT','与正式题库内容或答案冲突，请重新审核；不会自动覆盖正式答案');
     if(!duplicate)s.formal.push({...p.question,status:'verified'});
     s.resolved.push({id:p.id,question_id:p.question.question_id,status:'merged',target_id:duplicate?.question_id||p.question.question_id,actor:sha256(auth.openid)});
    }
    s.pending=s.pending.filter(p=>!body.candidate_ids.includes(p.id));s.release_version++;
   }else deny(405,'METHOD_NOT_ALLOWED','不支持此请求方法');
   return commit(s);
  }
 };
}
module.exports={createWorkflow,MAX_STATE_BYTES};
