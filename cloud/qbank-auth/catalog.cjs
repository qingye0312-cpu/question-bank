'use strict';
const {HttpError,sha256}=require('./common.cjs');
const {unpackText}=require('./codec.cjs');
// Bank catalogue and maintainer permissions share one versioned registry.
const {REGISTRY_ID,createAccessRegistry}=require('./access.cjs');
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail=(status,code,message)=>{throw new HttpError(status,code,message)};
function createCatalog({store,validateStandardQuestion,clock,releaseName,manifest}){
 const registry=createAccessRegistry({store,clock}).read;
 async function resolve(config){
  if(!config.syncEnabled)return config;
  const r=await registry();
  if(!Array.isArray(r.banks)||r.banks.length>100)throw Error('Invalid registry');
  const byId=new Map(config.banks.map(b=>[b.bank_id,b]));
  for(const b of r.banks){if(!UUID.test(b.bank_id)||b.bank_id===REGISTRY_ID||typeof b.name!=='string'||!/^d_[\w-]+$/.test(b.owner))throw Error('Invalid registry identity');if(byId.has(b.bank_id)&&byId.get(b.bank_id).name!==b.name)throw Error('Catalog name conflict');byId.set(b.bank_id,{bank_id:b.bank_id,name:b.name});}
  if(byId.size>100)fail(413,'CATALOG_FULL','云端题库目录已满');
  const banks=[...byId.values()];
  const maintainers=config.maintainers.map(m=>{const grants={...m.grants};for(const b of r.banks)if(b.owner===`d_${m.id}`)grants[b.bank_id]=[...new Set([...(grants[b.bank_id]||[]),'upload','merge'])];return {...m,grants};});
  return {...config,banks,maintainers};
 }
 async function promote(body,config,auth){
  if(!config.syncEnabled)fail(503,'SYNC_DISABLED','请先启用云端同步');
  if(!auth.desktop||!auth.capabilities?.includes('cloud_bank:create'))fail(403,'CREATE_FORBIDDEN','只有桌面最高权限账号可以设置云端题库');
  if(!UUID.test(body?.operation_id))fail(422,'OPERATION_INVALID','转换任务标识无效');
  let data;try{data=JSON.parse(unpackText(body.package))}catch{fail(422,'PACKAGE_INVALID','完整题库压缩包校验失败');}
  const {bank_id:id,name,questions}=data||{};
  if(!UUID.test(id)||id===REGISTRY_ID||typeof name!=='string'||!name.trim()||name.length>100||!Array.isArray(questions)||!questions.length||questions.length>10000)fail(422,'SEED_INVALID','请选择包含 1 至 10000 题的本地题库');
  const ids=new Set();for(const q of questions){try{validateStandardQuestion(q,name)}catch{fail(422,'QUESTION_INVALID','首版题目结构、身份或答案无效');}if(ids.has(q.question_id))fail(422,'DUPLICATE_ID','题目 ID 重复');ids.add(q.question_id);}
  const hash=sha256(JSON.stringify({actor:auth.openid,id,name,questions}));
  const matches=s=>s?.promotion?.id===body.operation_id&&s.promotion.hash===hash;
  let state=await store.readState(id);
  if(state&&!matches(state)||!state&&config.banks.some(b=>b.bank_id===id))fail(409,'BANK_EXISTS','该题库身份已在云端使用，请检查目录；不会覆盖');
  if(!state&&config.banks.length>=100)fail(413,'CATALOG_FULL','云端目录已满');
  if(!state){const at=new Date(clock()).toISOString(),releaseId=sha256(JSON.stringify(questions));state={format:'qbank-state-1',bank_id:id,name,revision:1,release_version:1,formal:questions,pending:[],resolved:[],batches:[],merge_history:[],updated_at:at,merged_at:at,release_id:releaseId,release_name:releaseName(at,name,'初建',1,id,releaseId),promotion:{id:body.operation_id,hash,owner:auth.openid}};
   if(Buffer.byteLength(JSON.stringify(state))>4194304)fail(413,'BANK_TOO_LARGE','完整题库超过 4 MiB 上限，本地数据已保留');
   if(!await store.createState(state)){state=await store.readState(id);if(!matches(state))fail(409,'BANK_EXISTS','另一任务已使用此题库身份');}
  }
  // A readable, checksummed first state must exist before its public catalog row.
  const verified=await store.readState(id);if(!matches(verified))fail(502,'STATE_NOT_VERIFIED','首版尚未确认可读，请重试原任务');
  for(let attempt=0;attempt<5;attempt++){
   const r=await registry(),old=r.banks.find(b=>b.bank_id===id);
   if(old){if(old.operation_id!==body.operation_id||old.owner!==auth.openid)fail(409,'BANK_EXISTS','题库已由其他创建任务激活');return manifest(verified);}
   if(r.banks.length>=100)fail(413,'CATALOG_FULL','云端目录已满，首版任务保留');
   r.banks.push({bank_id:id,name,owner:auth.openid,operation_id:body.operation_id});r.revision++;r.updated_at=new Date(clock()).toISOString();
   if(await store.createState(r))return manifest(verified);
  }
  fail(409,'REVISION_CONFLICT','目录正在更新，请重试同一转换任务');
 }
 return {resolve,promote};
}
module.exports={createCatalog,REGISTRY_ID};
