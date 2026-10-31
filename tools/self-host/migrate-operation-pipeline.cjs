'use strict';

const path=require('node:path');
function runtimeModule(name){try{return require(path.join(__dirname,name));}catch{return require(path.join(__dirname,'../../cloud/qbank-auth',name));}}
const {createFileStore}=runtimeModule('fs-store.cjs');
const {buildInitialOperation}=runtimeModule('operations.cjs');
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function configuredBanks(){
  try{const value=JSON.parse(process.env.QBANK_BANKS||'[]');return Array.isArray(value)?value.map(item=>item?.bank_id).filter(id=>UUID.test(id)):[];}
  catch{return [];}
}

async function main(){
  const root=process.env.QBANK_STORAGE_ROOT||'/var/lib/qbank-auth';
  const ids=[...new Set(process.argv.slice(2).filter(id=>UUID.test(id)).concat(configuredBanks()))];
  if(!ids.length)throw new Error('请传入题库 UUID，或在 QBANK_BANKS 中配置题库');
  const store=createFileStore({root}),result=[];
  for(const bankId of ids){
    const state=await store.readState(bankId);
    if(!state||!Array.isArray(state.formal)){result.push({bank_id:bankId,status:'skipped',reason:'题库尚未初始化'});continue;}
    const existing=await store.readOperations(bankId);
    if(existing){result.push({bank_id:bankId,status:'exists',revision:existing.current_revision,question_count:Object.keys(existing.question_index||{}).length});continue;}
    const pipeline=buildInitialOperation(state,{note:'历史题库初始化记录'});
    await store.writeOperations(pipeline);
    result.push({bank_id:bankId,status:'created',revision:pipeline.current_revision,question_count:Object.keys(pipeline.question_index).length});
  }
  console.log(JSON.stringify({storage_root:store.root,result}));
}

main().catch(error=>{console.error(error.message||String(error));process.exitCode=1;});
