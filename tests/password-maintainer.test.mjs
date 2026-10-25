import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseDelta,validateStandardQuestion,parseModelReply,sha256} from '../shared/intake.ts';

const require=createRequire(import.meta.url),{createHandler}=require('../cloud/qbank-auth/service.cjs');
const bankId='ad50971f-66af-51c2-bb0e-dc798b03b369',key='d'.repeat(64);
const password='StrongPass123';

function setup(){
 const current=new Map(),history=new Map(),records=new Map();
 const env={QBANK_SESSION_SECRET:'a'.repeat(64),QBANK_UPLOAD_ENABLED:'true',QBANK_SYNC_ENABLED:'true',
  QBANK_BANKS:JSON.stringify([{bank_id:bankId,name:'测试库'}]),QBANK_CLOUD_CREATORS:JSON.stringify(['maintainer-owner']),
  QBANK_MAINTAINERS:JSON.stringify([{id:'maintainer-owner',key_sha256:sha256(key),grants:{[bankId]:['upload','merge']}}])};
 const store={
  async readState(id){const value=current.get(id);return value?structuredClone(value):null;},
  async createState(value){const existing=current.get(value.bank_id);if(existing&&existing.revision>=value.revision)return false;const copy=structuredClone(value);current.set(value.bank_id,copy);history.set(`${value.bank_id}/${value.revision}`,copy);return true;},
  async readStateAt(id,revision){const value=history.get(`${id}/${revision}`);return value?structuredClone(value):null;},
  async listStates(id){return [...history.values()].filter(value=>value.bank_id===id).sort((a,b)=>b.revision-a.revision).map(value=>structuredClone(value));},
  async createSubmission(path,record){if(records.has(path))return {record:records.get(path),created:false};records.set(path,structuredClone(record));return {record,created:true};},
 };
 const handler=createHandler({env:()=>env,store,parseDelta,validateStandardQuestion,parseModelReply});
 const call=async(method,path,body,token)=>{const response=await handler({httpMethod:method,path,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.statusCode,data:JSON.parse(response.body)}};
 const admin=async()=>(await call('POST','/v1/auth/desktop',{key})).data.access_token;
 const register=async(patch={})=>call('POST','/v1/auth/register',{phone:'13812345678',real_name:'张三',nickname:'小星',identity_description:'课程助教',password,bank_ids:[bankId],...patch});
 const login=async(phone='13812345678',secret=password)=>call('POST','/v1/auth/password-login',{phone,password:secret});
 return {call,env,current,register,login,admin};
}

test('health uses self-hosted phone/password auth and the old WeChat route is gone',async()=>{
 const s=setup(),health=await s.call('GET','/health');
 assert.equal(health.status,200);
 assert.deepEqual(health.data.auth_checks,{QBANK_SESSION_SECRET:'ok',QBANK_BANKS:'ok'});
 assert.equal((await s.call('POST','/v1/auth/wechat-login',{login_code:'legacy'})).status,404);
 assert.equal((await s.call('POST','/v1/auth/wechat',{code:'legacy'})).status,404);
});

test('registration creates a phone account and password login survives refresh until logout',async()=>{
 const s=setup(),created=await s.register();
 assert.equal(created.status,201);assert.equal(created.data.account.phone,'138****5678');
 assert.equal(created.data.application.real_name,'张三');assert.equal('username' in created.data.application,false);
 const logged=await s.login();assert.equal(logged.status,200);assert.equal(logged.data.status,'pending');
 const me=await s.call('GET','/v1/me',undefined,logged.data.access_token);assert.equal(me.data.account_status,'pending');
 const refreshed=await s.call('POST','/v1/auth/refresh',{refresh_token:logged.data.refresh_token});
 assert.equal(refreshed.status,200);assert.equal(refreshed.data.refresh_token,logged.data.refresh_token);
 assert.equal((await s.call('POST','/v1/auth/logout',{refresh_token:logged.data.refresh_token})).status,200);
 assert.equal((await s.call('POST','/v1/auth/refresh',{refresh_token:logged.data.refresh_token})).status,401);
});

test('desktop highest privilege approves, lists and revokes a phone maintainer',async()=>{
 const s=setup(),created=await s.register(),admin=await s.admin(),user=await s.login();
 const applications=await s.call('GET','/v1/maintainer-applications',undefined,admin);
 assert.equal(applications.status,200);assert.equal(applications.data.applications[0].phone,'+8613812345678');
 assert.equal(applications.data.applications[0].identity_description,'课程助教');
 const decision=await s.call('POST',`/v1/maintainer-applications/${created.data.application.id}/decision`,{decision:'approve'},admin);
 assert.equal(decision.status,200);
 const access=await s.call('GET','/v1/me',undefined,user.data.access_token);
 assert.deepEqual(access.data.grants[bankId],['upload']);assert.deepEqual(access.data.permissions,['upload']);
 const accounts=await s.call('GET','/v1/maintainer-accounts',undefined,admin);
 assert.equal(accounts.data.accounts.length,1);assert.equal(accounts.data.accounts[0].phone,'+8613812345678');
 assert.equal('username' in accounts.data.accounts[0],false);
 assert.equal((await s.call('POST',`/v1/maintainer-accounts/${accounts.data.accounts[0].id}/revoke`,{},admin)).status,200);
 assert.equal((await s.call('GET','/v1/me',undefined,user.data.access_token)).status,403);
});

test('registration enforces shared phone/password fields and prevents duplicate phone registration',async()=>{
 const s=setup();
 assert.equal((await s.register({password:'weak'})).data.error.code,'PASSWORD_INVALID');
 assert.equal((await s.register({username:'legacy-user'})).data.error.code,'REGISTRATION_INVALID');
 assert.equal((await s.register()).status,201);
 const duplicate=await s.register();assert.equal(duplicate.status,409);assert.equal(duplicate.data.error.code,'PHONE_TAKEN');
});
