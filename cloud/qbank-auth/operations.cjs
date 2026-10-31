'use strict';

const {safeQuestion}=require('./projection.cjs');
const text=value=>JSON.stringify(value);
const questionComparable=question=>{try{return text(safeQuestion(question));}catch{return text(question);}};
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

module.exports={OPERATION_FORMAT,buildInitialOperation,appendOperation,diffQuestionIds,operationRevision,eventForState};
