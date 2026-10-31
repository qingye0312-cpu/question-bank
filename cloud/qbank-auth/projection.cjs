'use strict';
const {sha256}=require('./common.cjs');
const clean=s=>s.replace(/\r\n?/g,'\n').trim();
const key=q=>{const options=q.options.map(o=>clean(o.content));if(new Set(options).size===options.length)options.sort();return JSON.stringify([q.type,clean(q.stem),options]);};
const answer=q=>{if(!Array.isArray(q.answer))return JSON.stringify(q.answer);const repeated=new Set(q.options.map(o=>clean(o.content))).size!==q.options.length;return JSON.stringify(q.answer.map(k=>repeated?k:clean(q.options.find(o=>o.key===k)?.content||'')).sort());};
const safeQuestion=q=>{
 const sources=q.sources.filter(s=>s.kind==='model_reply'&&s.model&&typeof s.model.name==='string'&&typeof s.model.version==='string').map(s=>({kind:'model_reply',model:{name:s.model.name,version:s.model.version,version_source:['user','platform','unknown'].includes(s.model.version_source)?s.model.version_source:'unknown'},answer_origin:'inferred',...(s.recorded_at?{recorded_at:s.recorded_at}:{})}));
 const model=sources.find(s=>s.model)?.model;
 return {...q,sources,source_note:model?`原始模型 · ${model.name} / ${model.version}`:'正式题库来源',extensions:undefined};
};
function releaseName(at,name,stage,version,id,digest){const stamp=new Date(Date.parse(at)+28800000).toISOString().replace(/[-:TZ.]/g,'').slice(0,17).replace(/^(\d{8})(.*)$/,'$1-$2')+'+0800';const title=Array.from(name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').replace(/[. ]+$/,'')).slice(0,36).join('');return `${stamp}_${title}_${stage}_v${version}_${id.slice(0,8)}-${digest.slice(0,8)}`;}
 function questionFile(s){return {format:'qbank-question-bank-1',bank_id:s.bank_id,name:s.name,revision:s.revision,release_version:s.release_version,release_version_label:s.release_version_label||`v${s.release_version}`,
   updated_at:s.updated_at,merged_at:s.merged_at||null,release_name:s.release_name||null,release_id:s.release_id||null,rollback_at:s.rollback_at||null,rollback_of:s.rollback?.target_revision||null,questions:s.formal===null?null:s.formal.map(safeQuestion)};}
 function projected(s){return {format:'qbank-snapshot-2',bank_id:s.bank_id,name:s.name,revision:s.revision,release_version:s.release_version,release_version_label:s.release_version_label||`v${s.release_version}`,
   updated_at:s.updated_at,merged_at:s.merged_at||null,release_name:s.release_name||null,release_id:s.release_id||null,
   rollback_at:s.rollback_at||null,rollback_of:s.rollback?.target_revision||null,
   merges:Array.isArray(s.merge_history)?s.merge_history.map(m=>({batch_id:m.batch_id,merged_at:m.merged_at,question_count:m.question_count,added_count:m.added_count,duplicate_count:m.duplicate_count,revision:m.revision,release_version:m.release_version,release_version_label:m.release_version_label||`v${m.release_version}`,note:m.note||null})):[],
   formal:s.formal===null?null:s.formal.map(safeQuestion),pending:[],
   removed:s.resolved.map(r=>({question_id:r.question_id,status:r.status}))};}
 function manifest(s,files={}){const payload=JSON.stringify(projected(s)),questions=JSON.stringify(questionFile(s));return {bank_id:s.bank_id,name:s.name,revision:s.revision,release_version:s.release_version,release_version_label:s.release_version_label||`v${s.release_version}`,question_count:Array.isArray(s.formal)?s.formal.length:0,
   sha256:sha256(payload),bytes:Buffer.byteLength(payload),question_file_sha256:sha256(questions),question_file_bytes:Buffer.byteLength(questions),question_file_format:'qbank-question-bank-1',operations_file_sha256:files.operations_file_sha256||null,operations_file_bytes:files.operations_file_bytes||null,operations_file_format:files.operations_file_format||'qbank-operations-2',minimum_client:'0.2.7',protocol:3,snapshot_format:'qbank-cloud-file-1',merged_at:s.merged_at||null,release_name:s.release_name||null,release_id:s.release_id||null,rollback_at:s.rollback_at||null,rollback_of:s.rollback?.target_revision||null,updated_at:s.updated_at};}

module.exports={key,answer,safeQuestion,releaseName,questionFile,projected,manifest};
