import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseDelta,validateStandardQuestion,parseModelReply,sha256} from '../shared/intake.ts';
const require=createRequire(import.meta.url),{createHandler}=require('../cloud/qbank-auth/service.cjs');
const bankId='ad50971f-66af-51c2-bb0e-dc798b03b369',key='d'.repeat(64),openid='ok1993Y5Uw6nd3pd9nAJXk6ccciM';
function setup(){
 const env={WX_APP_ID:'wx22c8135ae81d3acc',WX_APP_SECRET:'test',QBANK_SESSION_SECRET:'a'.repeat(64),QBANK_UPLOAD_ENABLED:'true',QBANK_SYNC_ENABLED:'true',QBANK_BANKS:JSON.stringify([{bank_id:bankId,name:'测试库'}]),QBANK_CLOUD_CREATORS:JSON.stringify(['maintainer-owner']),QBANK_MAINTAINERS:JSON.stringify([{id:'maintainer-owner',key_sha256:sha256(key),grants:{[bankId]:['upload','merge']}}])};
 const states=new Map();
 const store={async readState(id){const latest=[...states.values()].filter(s=>s.bank_id===id).sort((a,b)=>b.revision-a.revision)[0];return latest?structuredClone(latest):null},async createState(s){if(states.has(`${s.bank_id}/${s.revision}`)||[...states.values()].some(v=>v.bank_id===s.bank_id&&v.revision>=s.revision))return false;states.set(`${s.bank_id}/${s.revision}`,structuredClone(s));return true},async listStates(id){return [...states.values()].filter(v=>v.bank_id===id).sort((a,b)=>b.revision-a.revision)},async readStateAt(id,r){return states.get(`${id}/${r}`)||null},async createSubmission(){throw Error('not used')}};
 const handler=createHandler({env:()=>env,store,parseDelta,validateStandardQuestion,parseModelReply,exchangePhone:async()=>({openid,phone:'+8613812345678'})});
 const call=async(method,path,body,token)=>{const r=await handler({httpMethod:method,path,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.statusCode,data:JSON.parse(r.body)}};
 return {call,env,states,admin:async()=> (await call('POST','/v1/auth/desktop',{key})).data.access_token,phone:async()=> (await call('POST','/v1/auth/wechat-phone',{login_code:'login-code',phone_code:'phone-code',nickname:'小星'})).data};
}
test('phone login creates a pending application and highest desktop account can approve/revoke it',async()=>{
 const s=setup(),admin=await s.admin(),pending=await s.phone();assert.equal(pending.status,'pending');assert.equal(pending.banks.length,0);
 const application=await s.call('POST','/v1/maintainer-applications',{bank_ids:[bankId],nickname:'小星',identity_description:'  测试班级\n负责题目整理  '},pending.access_token);assert.equal(application.status,201);
 const list=await s.call('GET','/v1/maintainer-applications',undefined,admin);assert.equal(list.status,200);assert.equal(list.data.applications[0].phone,'+861****5678');assert.equal(list.data.applications[0].identity_description,'测试班级\n负责题目整理');
 const decided=await s.call('POST',`/v1/maintainer-applications/${application.data.application.id}/decision`,{decision:'approve',grants:{[bankId]:['upload']}},admin);assert.equal(decided.status,200);
 const approved=await s.phone();assert.equal(approved.status,'approved');assert.equal(approved.banks[0].bank_id,bankId);const me=await s.call('GET','/v1/me',undefined,approved.access_token);assert.deepEqual(me.data.grants[bankId],['upload']);
 const accounts=await s.call('GET','/v1/maintainer-accounts',undefined,admin);const account=accounts.data.accounts[0];assert.equal(account.phone,'+861****5678');assert.equal(account.identity_description,'测试班级\n负责题目整理');
 assert.equal((await s.call('POST',`/v1/maintainer-accounts/${account.id}/revoke`,{},admin)).status,200);assert.equal((await s.call('GET','/v1/me',undefined,approved.access_token)).status,403);
});
test('the removed openid WeChat route is unavailable',async()=>{const s=setup();assert.equal((await s.call('POST','/v1/auth/wechat',{code:'legacy-code'})).status,404);});

test('identity description is required, bounded, and visible only to the highest desktop account',async()=>{
 const s=setup(),pending=await s.phone();
 for(const description of [undefined,42,'','  \n  ','字'.repeat(501)]){
  const result=await s.call('POST','/v1/maintainer-applications',{bank_ids:[bankId],identity_description:description},pending.access_token);
  assert.equal(result.status,422);assert.equal(result.data.error.code,'IDENTITY_REQUIRED');
 }
 const request={bank_ids:[bankId],identity_description:'字'.repeat(500)};
 assert.equal((await s.call('POST','/v1/maintainer-applications',request)).status,401);
 assert.equal((await s.call('POST','/v1/maintainer-applications',request,pending.access_token)).status,201);
 assert.equal((await s.call('GET','/v1/maintainer-applications',undefined,pending.access_token)).status,403);
 const listed=await s.call('GET','/v1/maintainer-applications',undefined,await s.admin());
 assert.equal(listed.data.applications.length,1);assert.equal(listed.data.applications[0].identity_description.length,500);
});
