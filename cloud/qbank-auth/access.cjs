'use strict';

// Maintainer applications and approvals live in the same immutable registry
// as the cloud-bank catalogue. Legacy WeChat records are retained as inert
// archive data; they can no longer authenticate or receive new permissions.
const {sha256,fail}=require('./common.cjs');
const REGISTRY_ID='00000000-0000-0000-0000-000000000000';

function normalizePhone(value){
  if(typeof value!=='string')fail(422,'PHONE_INVALID','请填写有效的 11 位手机号');
  const text=value.trim().replace(/[\s()-]/g,'').replace(/^(?:\+86|0086)/,'');
  if(!/^1[3-9]\d{9}$/.test(text))fail(422,'PHONE_INVALID','请填写有效的 11 位手机号');
  return '+86'+text;
}
function maskPhone(value){
  const text=String(value),digits=text.replace(/^\+/,'');
  return `${text.startsWith('+')?'+':''}${digits.slice(0,3)}****${digits.slice(-4)}`;
}
function normalizeStoredPhone(record){
  if(!record||typeof record!=='object'||typeof record.phone!=='string')return;
  try{
    const phone=normalizePhone(record.phone);
    record.phone=phone;
    record.phone_hash=sha256(phone);
    record.phone_masked=maskPhone(phone);
  }catch{/* Preserve malformed legacy records for explicit administrative repair. */}
}
function emptyRegistry(){return {format:'qbank-state-1',bank_id:REGISTRY_ID,revision:0,banks:[],legacy_accounts:[],password_accounts:[],maintainer_applications:[],updated_at:''};}
function cleanRegistry(value){
  if(!value)return emptyRegistry();
  if(value.format!=='qbank-state-1'||value.bank_id!==REGISTRY_ID||!Number.isSafeInteger(value.revision)||value.revision<0)
    throw new Error('Invalid access registry');
  const result={...emptyRegistry(),...structuredClone(value)};
  if(!Array.isArray(result.banks)||!Array.isArray(result.password_accounts)||!Array.isArray(result.maintainer_applications))throw new Error('Invalid access registry');
  if(!Array.isArray(result.legacy_accounts))result.legacy_accounts=Array.isArray(value.wechat_accounts)?value.wechat_accounts:[];
  delete result.wechat_accounts;
  for(const account of [...result.legacy_accounts,...result.password_accounts])if(account&&typeof account==='object')delete account.username;
  for(const application of result.maintainer_applications)if(application&&typeof application==='object')delete application.username;
  for(const account of result.password_accounts)normalizeStoredPhone(account);
  for(const application of result.maintainer_applications)normalizeStoredPhone(application);
  return result;
}

function passwordPhoneMatches(account,value){
  if(!account||typeof account!=='object')return false;
  let phone;
  try{phone=normalizePhone(value);}catch{return false;}
  const digest=sha256(phone);
  if(account.phone_hash===digest||account.phone===phone)return true;
  if(typeof account.phone!=='string')return false;
  try{return normalizePhone(account.phone)===phone;}catch{return false;}
}
function findPasswordAccount(registry,value){
  const matches=registry.password_accounts.filter(account=>passwordPhoneMatches(account,value));
  return matches.find(account=>account.status!=='revoked')||matches[0];
}

function createAccessRegistry({store,clock=Date.now}){
  async function read(){return cleanRegistry(await store.readState(REGISTRY_ID));}
  async function update(mutator){
    for(let attempt=0;attempt<6;attempt++){
      const current=await read(),next=structuredClone(current);
      await mutator(next);
      next.revision=current.revision+1;next.updated_at=new Date(clock()).toISOString();
      if(await store.createState(next))return structuredClone(next);
    }
    fail(409,'REVISION_CONFLICT','授权目录正在更新，请刷新后重试');
  }
  return {read,update,normalizePhone,maskPhone,phoneHash:value=>sha256(normalizePhone(value)),passwordPhoneMatches,findPasswordAccount,REGISTRY_ID};
}

module.exports={REGISTRY_ID,createAccessRegistry,normalizePhone,maskPhone,passwordPhoneMatches,findPasswordAccount};
