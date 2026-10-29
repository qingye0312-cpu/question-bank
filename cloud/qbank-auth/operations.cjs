'use strict';

const {safeQuestion}=require('./projection.cjs');

const clone=value=>value==null?value:structuredClone(value);
const text=value=>JSON.stringify(value);
const uploaderName=(...values)=>values.map(value=>typeof value==='string'?value.trim():'').find(value=>value&&value!=='未记录')||'star';

function uploaderFor(state,merge){
  if(merge)return {account_id:merge.uploader_account_id||null,real_name:uploaderName(merge.uploader_real_name),nickname:uploaderName(merge.uploader_nickname),auth_type:merge.uploader_auth_type||null};
  if(state.revision===1||state.seed_uploader_account_id||state.seed_uploader_real_name)
    return {account_id:state.seed_uploader_account_id||null,real_name:uploaderName(state.seed_uploader_real_name),nickname:null,auth_type:null};
  return {account_id:null,real_name:'系统',nickname:null,auth_type:null};
}

function revisionKind(state,merge){
  if(state.rollback&&Number.isSafeInteger(state.rollback.target_revision))return 'rollback';
  if(merge)return 'merge';
  return state.revision===1?'seed':'state';
}

function questionComparable(question){
  try{return text(safeQuestion(question));}catch{return text(question);}
}

function buildOperationFile(states,{bankId,name}={}){
  const ordered=states.filter(state=>state&&Array.isArray(state.formal)).sort((a,b)=>a.revision-b.revision);
  const questions=new Map(),revisions=[];
  let previous=null;
  for(const state of ordered){
    const merge=(state.merge_history||[]).find(item=>item.revision===state.revision)||null;
    const kind=revisionKind(state,merge),releaseVersionLabel=state.release_version_label||`v${state.release_version}`;
    const at=state.updated_at||state.merged_at||'';
    const uploader=uploaderFor(state,merge);
    const before=new Map((previous?.formal||[]).map(question=>[question.question_id,question]));
    const current=new Map((state.formal||[]).map(question=>[question.question_id,question]));
    const events=[];
    for(const question of [...current.values()].sort((a,b)=>a.question_id.localeCompare(b.question_id))){
      const old=before.get(question.question_id);
      const changed=!old?true:questionComparable(old)!==questionComparable(question);
      if(!changed)continue;
      const action=!old?(kind==='rollback'?'restored':'added'):(kind==='rollback'?'restored':'revised');
      const aggregate=questions.get(question.question_id);
      const enteredRevision=aggregate?.first_revision||state.revision;
      const event={question_id:question.question_id,action,uploaded_at:at,uploader:clone(uploader),entered_revision:enteredRevision,entered_release_version:aggregate?.first_release_version||state.release_version};
      events.push(event);
      if(!aggregate)questions.set(question.question_id,{question_id:question.question_id,first_revision:state.revision,first_release_version:state.release_version,first_release_version_label:releaseVersionLabel,first_uploaded_at:at,first_uploader:clone(uploader),revisions:[]});
      const item=questions.get(question.question_id);
      item.revisions.push({...event,revision:state.revision,release_version:state.release_version,release_version_label:releaseVersionLabel});
    }
    for(const question of [...before.values()].filter(question=>!current.has(question.question_id)).sort((a,b)=>a.question_id.localeCompare(b.question_id))){
      const aggregate=questions.get(question.question_id);
      const event={question_id:question.question_id,action:'removed',uploaded_at:at,uploader:clone(uploader),entered_revision:aggregate?.first_revision||null,entered_release_version:aggregate?.first_release_version||null};
      events.push(event);
      if(!aggregate)questions.set(question.question_id,{question_id:question.question_id,first_revision:null,first_release_version:null,first_release_version_label:null,first_uploaded_at:null,first_uploader:null,revisions:[]});
      questions.get(question.question_id).revisions.push({...event,revision:state.revision,release_version:state.release_version,release_version_label:releaseVersionLabel});
    }
    const addedCount=events.filter(event=>event.action==='added'||event.action==='restored').length;
    const revisedCount=events.filter(event=>event.action==='revised').length;
    const removedCount=events.filter(event=>event.action==='removed').length;
    revisions.push({revision:state.revision,kind,release_version:state.release_version,release_version_label:releaseVersionLabel,updated_at:at,merged_at:state.merged_at||null,release_name:state.release_name||null,release_id:state.release_id||null,batch_id:merge?.batch_id||null,question_count:Number.isSafeInteger(merge?.question_count)?merge.question_count:(state.formal||[]).length,added_count:addedCount,changed_count:addedCount+revisedCount,duplicate_count:Number.isSafeInteger(merge?.duplicate_count)?merge.duplicate_count:0,revised_count:revisedCount,removed_count:removedCount,rollback_of:state.rollback?.target_revision||null,uploader:clone(uploader),questions:events});
    previous=state;
  }
  const latest=ordered.at(-1)||null;
  return {format:'qbank-operations-1',bank_id:bankId||latest?.bank_id,name:name||latest?.name||'',current_revision:latest?.revision||0,current_release_version:latest?.release_version||0,current_release_version_label:latest?.release_version_label||`v${latest?.release_version||0}`,updated_at:latest?.updated_at||'',revisions:revisions.reverse(),questions:[...questions.values()].sort((a,b)=>a.question_id.localeCompare(b.question_id))};
}

module.exports={buildOperationFile};
