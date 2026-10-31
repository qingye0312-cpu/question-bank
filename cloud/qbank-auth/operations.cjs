'use strict';

const {safeQuestion}=require('./projection.cjs');

const clone=value=>value==null?value:structuredClone(value);
const text=value=>JSON.stringify(value);
const uploaderName=(...values)=>values.map(value=>typeof value==='string'?value.trim():'').find(value=>value&&value!=='未记录')||'star';
const OPERATION_FORMAT='qbank-operations-2';
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ids=values=>[...new Set((Array.isArray(values)?values:[]).filter(value=>UUID.test(value)))].sort();
const operatorName=(...values)=>values.map(value=>typeof value==='string'?value.trim():'').find(value=>value&&value!=='未记录')||'系统';

function normalizeOperator(value,fallback='系统'){
  const source=value&&typeof value==='object'?value:{};
  return {account_id:typeof source.account_id==='string'&&source.account_id?source.account_id:null,
    real_name:operatorName(source.real_name,fallback),nickname:typeof source.nickname==='string'&&source.nickname.trim()&&source.nickname.trim()!=='未记录'?source.nickname.trim():null,
    auth_type:typeof source.auth_type==='string'&&source.auth_type?source.auth_type:null};
}

function stateOperator(state,event){
  const merge=(state?.merge_history||[]).find(item=>item.revision===state?.revision)||null;
  const source=event?.operator||event?.uploader||merge||{};
  return normalizeOperator({account_id:source.account_id||source.uploader_account_id||state?.seed_uploader_account_id,
    real_name:source.real_name||source.uploader_real_name||state?.seed_uploader_real_name,
    nickname:source.nickname||source.uploader_nickname,auth_type:source.auth_type||source.uploader_auth_type},state?.revision===1?'首版维护者':'系统');
}

function stateQuestionMap(formal){return new Map((Array.isArray(formal)?formal:[]).filter(q=>UUID.test(q?.question_id)).map(q=>[q.question_id,q]));}

function diffQuestionIds(previous,current){
  const before=stateQuestionMap(previous),after=stateQuestionMap(current),added=[],revised=[],removed=[];
  for(const [questionId,question] of after){
    const old=before.get(questionId);
    if(!old)added.push(questionId);
    else if(questionComparable(old)!==questionComparable(question))revised.push(questionId);
  }
  for(const questionId of before.keys())if(!after.has(questionId))removed.push(questionId);
  return {added:ids(added),revised:ids(revised),removed:ids(removed)};
}

function eventForState(state){
  if(state?.operation_event&&typeof state.operation_event==='object')return state.operation_event;
  const merge=(state?.merge_history||[]).find(item=>item.revision===state?.revision)||null;
  if(merge)return {kind:'merge',operator:{account_id:merge.uploader_account_id,real_name:merge.uploader_real_name,nickname:merge.uploader_nickname,auth_type:merge.uploader_auth_type},note:merge.note||null,question_count:merge.question_count,duplicate_count:merge.duplicate_count,added:merge.added_question_ids||[],revised:[],removed:[]};
  return {kind:state?.rollback?'rollback':state?.revision===1?'seed':'state',operator:stateOperator(state),note:null,added:[],revised:[],removed:[]};
}

function operationRevision(state,event=eventForState(state)){
  const merge=(state?.merge_history||[]).find(item=>item.revision===state?.revision)||null;
  const added=ids(event.added),revised=ids(event.revised),removed=ids(event.removed);
  const kind=['bootstrap','seed','merge','rollback','state'].includes(event.kind)?event.kind:(state?.rollback?'rollback':merge?'merge':state?.revision===1?'seed':'state');
  const at=state?.updated_at||state?.merged_at||'';
  return {revision:state?.revision||0,kind,release_version:state?.release_version||0,release_version_label:state?.release_version_label||`v${state?.release_version||0}`,
    operated_at:at,merged_at:state?.merged_at||null,release_name:state?.release_name||null,release_id:state?.release_id||null,batch_id:event.batch_id||merge?.batch_id||null,
    note:event.note??merge?.note??null,question_count:Number.isSafeInteger(event.question_count)?event.question_count:Number.isSafeInteger(merge?.question_count)?merge.question_count:(Array.isArray(state?.formal)?state.formal.length:0),
    added_count:added.length,changed_count:added.length+revised.length,duplicate_count:Number.isSafeInteger(event.duplicate_count)?event.duplicate_count:Number.isSafeInteger(merge?.duplicate_count)?merge.duplicate_count:0,
    revised_count:revised.length,removed_count:removed.length,rollback_of:event.rollback_of??state?.rollback?.target_revision??null,operator:normalizeOperator(event.operator,state?.revision===1?'首版维护者':'系统'),added,revised,removed};
}

function buildInitialOperation(state,{name,operator,note='历史题库初始化记录',event=null}={}){
  const formal=Array.isArray(state?.formal)?state.formal:[],revision=Number.isSafeInteger(state?.revision)?state.revision:0;
  const questionIds=ids(formal.map(question=>question.question_id));
  const pipeline={format:OPERATION_FORMAT,bank_id:state?.bank_id||'',name:name||state?.name||'',current_revision:revision,current_release_version:state?.release_version||0,
    current_release_version_label:state?.release_version_label||`v${state?.release_version||0}`,updated_at:state?.updated_at||'',question_index:Object.fromEntries(questionIds.map(questionId=>[questionId,revision])),revisions:[]};
  if(revision>0){
    const first=event&&event.kind==='seed'?event:{kind:'bootstrap',operator:operator||{real_name:'系统'},note,question_count:questionIds.length,added:questionIds,revised:[],removed:[]};
    pipeline.revisions.push(operationRevision(state,first));
  }
  return pipeline;
}

function appendOperation(pipeline,state,event=eventForState(state)){
  if(!pipeline||pipeline.format!==OPERATION_FORMAT)throw new Error('Invalid operation pipeline');
  if(!Number.isSafeInteger(state?.revision)||state.revision<1)throw new Error('Invalid operation revision');
  if(state.revision<=pipeline.current_revision)return pipeline;
  if(state.revision!==pipeline.current_revision+1)throw new Error('Operation pipeline has a revision gap');
  const revision=operationRevision(state,event),questionIndex={...(pipeline.question_index||{})};
  for(const questionId of [...revision.added,...revision.revised])questionIndex[questionId]=revision.revision;
  for(const questionId of revision.removed)delete questionIndex[questionId];
  return {...pipeline,current_revision:revision.revision,current_release_version:revision.release_version,current_release_version_label:revision.release_version_label,
    updated_at:revision.operated_at,question_index:questionIndex,revisions:[...(pipeline.revisions||[]),revision]};
}

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
    revisions.push({revision:state.revision,kind,release_version:state.release_version,release_version_label:releaseVersionLabel,updated_at:at,merged_at:state.merged_at||null,release_name:state.release_name||null,release_id:state.release_id||null,batch_id:merge?.batch_id||null,note:merge?.note||null,question_count:Number.isSafeInteger(merge?.question_count)?merge.question_count:(state.formal||[]).length,added_count:addedCount,changed_count:addedCount+revisedCount,duplicate_count:Number.isSafeInteger(merge?.duplicate_count)?merge.duplicate_count:0,revised_count:revisedCount,removed_count:removedCount,rollback_of:state.rollback?.target_revision||null,uploader:clone(uploader),questions:events});
    previous=state;
  }
  const latest=ordered.at(-1)||null;
  return {format:'qbank-operations-1',bank_id:bankId||latest?.bank_id,name:name||latest?.name||'',current_revision:latest?.revision||0,current_release_version:latest?.release_version||0,current_release_version_label:latest?.release_version_label||`v${latest?.release_version||0}`,updated_at:latest?.updated_at||'',revisions:revisions.reverse(),questions:[...questions.values()].sort((a,b)=>a.question_id.localeCompare(b.question_id))};
}

module.exports={buildOperationFile,OPERATION_FORMAT,buildInitialOperation,appendOperation,diffQuestionIds,operationRevision,eventForState};
