'use strict';

const {sha256}=require('./common.cjs');
const {key,answer,releaseName}=require('./projection.cjs');
const {diffQuestionIds}=require('./operations.cjs');

const statusRank={verified:0,unreviewed:1,needs_review:2};
const uniqueStrings=values=>[...new Set(values.filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()))];
const uniqueObjects=values=>[...new Map(values.map(value=>[JSON.stringify(value),value])).values()];
const richness=q=>(q.sources||[]).length*10000+(q.explanation||'').length*10+(q.tags||[]).length;

function repairDuplicateOptions(question){
  if(!Array.isArray(question.options)||!question.options.length)return false;
  const seen=new Map(),kept=[],mapping=new Map();
  for(const option of question.options){
    const content=String(option.content||'').normalize('NFKC').trim();
    const existing=seen.get(content);
    if(existing){mapping.set(option.key,existing.key);continue;}
    seen.set(content,option);kept.push(option);
  }
  if(kept.length===question.options.length)return false;
  if(Array.isArray(question.answer))question.answer=[...new Set(question.answer.map(value=>mapping.get(value)||value))].sort();
  question.options=kept;
  question.tags=uniqueStrings([...(question.tags||[]),'选项去重']);
  return true;
}

function mergeDuplicates(kept,incoming){
  const a=richness(incoming)>richness(kept)?incoming:kept;
  const b=a===incoming?kept:incoming;
  const merged={...a};
  merged.external_id=uniqueStrings([kept.external_id,incoming.external_id]).join(' / ');
  merged.tags=uniqueStrings([...(kept.tags||[]),...(incoming.tags||[]),'重复题合并']);
  merged.issues=uniqueStrings([...(kept.issues||[]),...(incoming.issues||[])]);
  merged.sources=uniqueObjects([...(kept.sources||[]),...(incoming.sources||[])]);
  merged.status=statusRank[kept.status]>=statusRank[incoming.status]?kept.status:incoming.status;
  merged.base_revision=Math.max(kept.base_revision||0,incoming.base_revision||0);
  merged.updated_at=[kept.updated_at,incoming.updated_at].filter(Boolean).sort().at(-1)||null;
  return merged;
}

function repairQuestionBank(state,{validateQuestion,clock=Date.now}={}){
  if(!state||!Array.isArray(state.formal))throw new Error('题库尚未初始化');
  if(typeof validateQuestion!=='function')throw new Error('题目校验器缺失');
  const next=structuredClone(state),optionRepairs=[];
  for(const question of next.formal){
    if(repairDuplicateOptions(question)){
      optionRepairs.push({
        question_id:question.question_id,
        external_id:question.external_id||'',
        stem:String(question.stem||'').slice(0,160),
        option_count:question.options.length,
        answer:question.answer,
      });
    }
  }

  const positions=new Map(),unique=[],duplicates=[];
  for(const question of next.formal){
    let identity,canonicalAnswer;
    try{identity=key(question);canonicalAnswer=answer(question);}
    catch{throw new Error(`题目无法参与去重：${question.question_id||'未知 ID'}`);}
    const groupKey=`${identity}\n${canonicalAnswer}`;
    const position=positions.get(groupKey);
    if(position===undefined){
      positions.set(groupKey,unique.length);
      unique.push(question);
      continue;
    }
    const kept=unique[position];
    duplicates.push({
      kept_question_id:kept.question_id,
      removed_question_id:question.question_id,
      kept_external_id:kept.external_id||'',
      removed_external_id:question.external_id||'',
      stem:String(question.stem||'').slice(0,160),
    });
    unique[position]=mergeDuplicates(kept,question);
  }
  next.formal=unique;
  for(const question of next.formal)validateQuestion(question,next.name);

  if(!duplicates.length&&!optionRepairs.length){
    return {changed:false,before:state.formal.length,after:next.formal.length,duplicates:[],optionRepairs:[],revision:state.revision};
  }
  const at=new Date(clock()).toISOString();
  next.revision++;
  next.release_version++;
  next.release_version_label=`v${next.release_version}`;
  next.updated_at=at;
  next.merged_at=at;
  next.release_id=sha256(JSON.stringify(next.formal));
  next.release_name=releaseName(at,next.name,'题目质量修复',next.release_version,next.bank_id,next.release_id);
  next.quality_repairs=[...(next.quality_repairs||[]),{
    at,
    from_revision:state.revision,
    revision:next.revision,
    removed_duplicate_count:duplicates.length,
    repaired_option_count:optionRepairs.length,
    before_count:state.formal.length,
    after_count:next.formal.length,
    duplicates,
    option_repairs:optionRepairs,
  }];
  const changes=diffQuestionIds(state.formal,next.formal);
  next.operation_event={revision:next.revision,operated_at:at,kind:'state',operator:{account_id:null,real_name:'系统',nickname:null,auth_type:null},note:'题目质量修复',
    question_count:next.formal.length,duplicate_count:duplicates.length,added:changes.added,revised:changes.revised,removed:changes.removed};
  if(Buffer.byteLength(JSON.stringify(next))>4194304)throw new Error('修复后的题库超过大小限制');
  return {
    state:next,
    changed:true,
    before:state.formal.length,
    after:next.formal.length,
    duplicates,
    optionRepairs,
    revision:next.revision,
    release_version:next.release_version,
    release_name:next.release_name,
  };
}

module.exports={repairQuestionBank,repairDuplicateOptions};
