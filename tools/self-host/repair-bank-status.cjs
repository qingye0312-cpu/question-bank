'use strict';
const {createHash}=require('node:crypto');
const sha256=text=>createHash('sha256').update(text).digest('hex');
const path=require('node:path');
function runtimeModule(name){try{return require(path.join(__dirname,name));}catch{return require(path.join(__dirname,'../../cloud/qbank-auth',name));}}
const {diffQuestionIds}=runtimeModule('operations.cjs');

// Repairs contradictory quality metadata only. Never creates or guesses answers.
async function repairBankStatus({store,bankId,validateQuestion,releaseName,clock=Date.now}){
 const current=await store.readState(bankId);
 if(!current||!Array.isArray(current.formal))throw Error('题库尚未初始化');
 const next=structuredClone(current),changed=[];
 for(const q of next.formal){
  try{validateQuestion(q,next.name)}catch(error){
   if(q.answer!==null||q.status==='needs_review'||!Array.isArray(q.issues)||!q.issues.length)throw error;
   const previous=q.status;q.status='needs_review';validateQuestion(q,next.name);
   changed.push({question_id:q.question_id,from:previous,to:q.status});
  }
 }
 if(!changed.length)return {changed:0,revision:current.revision};
 const at=new Date(clock()).toISOString();next.revision++;next.release_version++;
 next.updated_at=at;next.merged_at=at;next.release_id=sha256(JSON.stringify(next.formal));
 next.release_name=releaseName(at,next.name,'状态修正',next.release_version,bankId,next.release_id);
 next.metadata_repairs=[...(next.metadata_repairs||[]),{at,from_revision:current.revision,revision:next.revision,changes:changed}];
 const ids=diffQuestionIds(current.formal,next.formal);
 next.operation_event={revision:next.revision,operated_at:at,kind:'state',operator:{account_id:null,real_name:'系统',nickname:null,auth_type:null},note:'题目状态修正',question_count:next.formal.length,duplicate_count:0,added:ids.added,revised:ids.revised,removed:ids.removed};
 if(Buffer.byteLength(JSON.stringify(next))>4194304)throw Error('修复后的题库超过大小限制');
 if(!await store.createState(next))throw Error('题库已被其他任务更新，请重新检查后重试');
 const verified=await store.readState(bankId);
 if(verified.revision!==next.revision||verified.release_id!==next.release_id)throw Error('修复后的版本尚未确认');
 return {changed:changed.length,revision:next.revision,release_version:next.release_version,questions:next.formal.length};
}
module.exports={repairBankStatus};
if(require.main===module){
 const {createFileStore}=require('./fs-store.cjs'),{validateStandardQuestion}=require('./intake.cjs'),{releaseName}=require('./projection.cjs');
 const [bankId,root='/var/lib/qbank-auth']=process.argv.slice(2);
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bankId||''))throw Error('请传入题库 UUID');
 repairBankStatus({store:createFileStore({root}),bankId,validateQuestion:validateStandardQuestion,releaseName})
  .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1});
}
