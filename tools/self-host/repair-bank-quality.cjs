'use strict';

const {createFileStore}=require('./fs-store.cjs');
const {repairQuestionBank}=require('./quality-repair.cjs');
const {validateStandardQuestion}=require('./intake.cjs');

async function main(){
  const [bankId,root='/var/lib/qbank-auth']=process.argv.slice(2);
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bankId||''))throw new Error('请传入题库 UUID');
  const store=createFileStore({root});
  const current=await store.readState(bankId);
  const result=repairQuestionBank(current,{validateQuestion:validateStandardQuestion});
  if(!result.changed){console.log(JSON.stringify({changed:false,revision:result.revision,questions:result.after}));return;}
  if(!await store.createState(result.state))throw new Error('题库已被其他任务更新，请重新检查后重试');
  const verified=await store.readState(bankId);
  if(verified.revision!==result.revision||verified.release_id!==result.state.release_id)throw new Error('修复后的版本尚未确认');
  const {state,...summary}=result;
  console.log(JSON.stringify(summary));
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
