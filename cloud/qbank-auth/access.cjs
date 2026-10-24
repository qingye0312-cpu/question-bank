'use strict';

// WeChat maintainer applications and approvals live in the same immutable
// registry state as the cloud-bank catalogue. This keeps approvals durable in
// the filesystem self-host without introducing a second mutable configuration.
const {OPENID,sha256,fail}=require('./common.cjs');
const REGISTRY_ID='00000000-0000-0000-0000-000000000000';
const PHONE=/^\+?[0-9]{6,20}$/;

function normalizePhone(value){
  if(typeof value!=='string')fail(422,'PHONE_INVALID','微信未返回有效手机号');
  const text=value.trim().replace(/[\s()-]/g,'');
  if(!PHONE.test(text))fail(422,'PHONE_INVALID','微信未返回有效手机号');
  return text;
}
function maskPhone(value){
  const text=String(value),digits=text.replace(/^\+/,'');
  return `${text.startsWith('+')?'+':''}${digits.slice(0,3)}****${digits.slice(-4)}`;
}
function emptyRegistry(){return {format:'qbank-state-1',bank_id:REGISTRY_ID,revision:0,banks:[],wechat_accounts:[],maintainer_applications:[],updated_at:''};}
function cleanRegistry(value){
  if(!value)return emptyRegistry();
  if(value.format!=='qbank-state-1'||value.bank_id!==REGISTRY_ID||!Number.isSafeInteger(value.revision)||value.revision<0)
    throw new Error('Invalid access registry');
  const result={...emptyRegistry(),...structuredClone(value)};
  if(!Array.isArray(result.banks)||!Array.isArray(result.wechat_accounts)||!Array.isArray(result.maintainer_applications))throw new Error('Invalid access registry');
  return result;
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
  async function findPhone(phoneHash){return (await read()).wechat_accounts.find(a=>a.phone_hash===phoneHash)||null;}
  return {read,update,findPhone,normalizePhone,maskPhone,phoneHash:value=>sha256(normalizePhone(value)),REGISTRY_ID};
}

function validateWechatIdentity(identity){
  if(!identity||typeof identity!=='object'||!OPENID.test(identity.openid))fail(401,'WECHAT_LOGIN_FAILED','微信登录凭证无效，请重新登录');
  const phone=normalizePhone(identity.phone);
  return {openid:identity.openid,phone,phone_hash:sha256(phone),phone_masked:maskPhone(phone),nickname:typeof identity.nickname==='string'?identity.nickname.trim().slice(0,80):''};
}

module.exports={REGISTRY_ID,createAccessRegistry,normalizePhone,maskPhone,validateWechatIdentity};
