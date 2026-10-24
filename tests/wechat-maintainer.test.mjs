import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {parseDelta,validateStandardQuestion,parseModelReply,sha256} from '../shared/intake.ts';
const require=createRequire(import.meta.url),{createHandler}=require('../cloud/qbank-auth/service.cjs');
const bankId='ad50971f-66af-51c2-bb0e-dc798b03b369',key='d'.repeat(64),openid='ok1993Y5Uw6nd3pd9nAJXk6ccciM';
function setup(){
 let currentOpenid=openid;
 const env={WX_APP_ID:'wx22c8135ae81d3acc',WX_APP_SECRET:'test',QBANK_SESSION_SECRET:'a'.repeat(64),QBANK_UPLOAD_ENABLED:'true',QBANK_SYNC_ENABLED:'true',QBANK_BANKS:JSON.stringify([{bank_id:bankId,name:'测试库'}]),QBANK_CLOUD_CREATORS:JSON.stringify(['maintainer-owner']),QBANK_MAINTAINERS:JSON.stringify([{id:'maintainer-owner',key_sha256:sha256(key),grants:{[bankId]:['upload','merge']}}])};
 const states=new Map();
 const store={async readState(id){const latest=[...states.values()].filter(s=>s.bank_id===id).sort((a,b)=>b.revision-a.revision)[0];return latest?structuredClone(latest):null},async createState(s){if(states.has(`${s.bank_id}/${s.revision}`)||[...states.values()].some(v=>v.bank_id===s.bank_id&&v.revision>=s.revision))return false;states.set(`${s.bank_id}/${s.revision}`,structuredClone(s));return true},async listStates(id){return [...states.values()].filter(v=>v.bank_id===id).sort((a,b)=>b.revision-a.revision)},async readStateAt(id,r){return states.get(`${id}/${r}`)||null},async createSubmission(){throw Error('not used')}};
 const handler=createHandler({env:()=>env,store,parseDelta,validateStandardQuestion,parseModelReply,exchangeWechat:async()=>({openid:currentOpenid})});
 const call=async(method,path,body,token)=>{const r=await handler({httpMethod:method,path,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.statusCode,data:JSON.parse(r.body)}};
 return {call,env,states,as:id=>{currentOpenid=id},admin:async()=> (await call('POST','/v1/auth/desktop',{key})).data.access_token,login:async()=> (await call('POST','/v1/auth/wechat-login',{login_code:'login-code'})).data};
}
test('manual application with WeChat login creates a pending application and highest desktop account can approve/revoke it',async()=>{
 const s=setup(),admin=await s.admin(),pending=await s.login();assert.equal(pending.status,'pending');assert.equal(pending.banks.length,0);
 const application=await s.call('POST','/v1/maintainer-applications',{bank_ids:[bankId],phone:'13812345678',real_name:'张三',nickname:'小星',identity_description:'  测试班级\n负责题目整理  '},pending.access_token);assert.equal(application.status,201);
 const list=await s.call('GET','/v1/maintainer-applications',undefined,admin);assert.equal(list.status,200);assert.equal(list.data.applications[0].phone,'+8613812345678');assert.equal(list.data.applications[0].identity_description,'测试班级\n负责题目整理');
 const decided=await s.call('POST',`/v1/maintainer-applications/${application.data.application.id}/decision`,{decision:'approve',grants:{[bankId]:['upload']}},admin);assert.equal(decided.status,200);
 const approved=await s.login();assert.equal(approved.status,'approved');assert.equal(approved.banks[0].bank_id,bankId);const me=await s.call('GET','/v1/me',undefined,approved.access_token);assert.deepEqual(me.data.grants[bankId],['upload']);
 const accounts=await s.call('GET','/v1/maintainer-accounts',undefined,admin);const account=accounts.data.accounts[0];assert.equal(account.phone,'+8613812345678');assert.equal(account.identity_description,'测试班级\n负责题目整理');
 assert.equal((await s.call('POST',`/v1/maintainer-accounts/${account.id}/revoke`,{},admin)).status,200);assert.equal((await s.call('GET','/v1/me',undefined,approved.access_token)).status,403);
});
test('the removed openid WeChat route is unavailable',async()=>{const s=setup();assert.equal((await s.call('POST','/v1/auth/wechat',{code:'legacy-code'})).status,404);assert.equal((await s.call('POST','/v1/auth/wechat-phone',{phone_code:'removed'})).status,404);});

test('identity description is required, bounded, and visible only to the highest desktop account',async()=>{
 const s=setup(),pending=await s.login();
 for(const description of [undefined,42,'','  \n  ','字'.repeat(501)]){
  const result=await s.call('POST','/v1/maintainer-applications',{bank_ids:[bankId],phone:'13812345678',real_name:'张三',identity_description:description},pending.access_token);
  assert.equal(result.status,422);assert.equal(result.data.error.code,'IDENTITY_REQUIRED');
 }
 const request={bank_ids:[bankId],phone:'13812345678',real_name:'张三',identity_description:'字'.repeat(500)};
 assert.equal((await s.call('POST','/v1/maintainer-applications',request)).status,401);
 assert.equal((await s.call('POST','/v1/maintainer-applications',request,pending.access_token)).status,201);
 assert.equal((await s.call('GET','/v1/maintainer-applications',undefined,pending.access_token)).status,403);
 const listed=await s.call('GET','/v1/maintainer-applications',undefined,await s.admin());
 assert.equal(listed.data.applications.length,1);assert.equal(listed.data.applications[0].identity_description.length,500);
});

const form={bank_ids:[bankId],phone:'13812345678',real_name:'张三',nickname:'',identity_description:'课程助教'};
test('manual phone and real name are required; typed phone cannot authenticate another WeChat account',async()=>{
 const s=setup(),admin=await s.admin(),owner=await s.login();
 for(const fields of [{phone:''},{phone:'123'},{phone:13812345678},{real_name:''},{real_name:'字'.repeat(41)}]){
  const invalid=await s.call('POST','/v1/maintainer-applications',{...form,...fields},owner.access_token);assert.equal(invalid.status,422);
 }
 const app=await s.call('POST','/v1/maintainer-applications',form,owner.access_token);assert.equal(app.status,201);
 const listed=await s.call('GET','/v1/maintainer-applications',undefined,admin);assert.equal(listed.data.applications[0].real_name,'张三');assert.equal(listed.data.applications[0].phone_source,'self_reported');
 await s.call('POST',`/v1/maintainer-applications/${app.data.application.id}/decision`,{decision:'approve'},admin);
 s.as('ok-other-wechat');const other=await s.login();assert.equal(other.banks.length,0);
 const rejected=await s.call('POST','/v1/maintainer-applications',form,other.access_token);assert.equal(rejected.status,409);assert.equal(rejected.data.error.code,'PHONE_IN_USE');
 const me=await s.call('GET','/v1/me',undefined,other.access_token);assert.deepEqual(me.data.permissions,[]);
});
test('existing maintainer can apply for a second bank without losing the first grant or duplicating their account',async()=>{
 const s=setup(),second=randomUUID();s.env.QBANK_BANKS=JSON.stringify([{bank_id:bankId,name:'初级'},{bank_id:second,name:'高级'}]);
 const admin=await s.admin(),user=await s.login();
 const first=await s.call('POST','/v1/maintainer-applications',form,user.access_token);
 await s.call('POST',`/v1/maintainer-applications/${first.data.application.id}/decision`,{decision:'approve'},admin);
 const secondForm={...form,bank_ids:[second]};
 const next=await s.call('POST','/v1/maintainer-applications',secondForm,user.access_token);assert.equal(next.status,201);
 const repeat=await s.call('POST','/v1/maintainer-applications',{...secondForm,identity_description:'高级课程助教'},user.access_token);assert.equal(repeat.status,200);assert.equal(repeat.data.application.id,next.data.application.id);
 const before=await s.call('GET','/v1/me',undefined,user.access_token);assert.deepEqual(before.data.banks.map(b=>b.bank_id),[bankId]);
 await s.call('POST',`/v1/maintainer-applications/${next.data.application.id}/decision`,{decision:'approve'},admin);
 const after=await s.call('GET','/v1/me',undefined,user.access_token);assert.deepEqual(after.data.banks.map(b=>b.bank_id),[bankId,second]);
 const accounts=await s.call('GET','/v1/maintainer-accounts',undefined,admin);assert.equal(accounts.data.accounts.length,1);
 assert.equal(accounts.data.accounts[0].identity_description,'高级课程助教');
});
test('two pending requests cannot obtain duplicate approved phone ownership',async()=>{
 const s=setup(),admin=await s.admin(),first=await s.login();
 const a=await s.call('POST','/v1/maintainer-applications',form,first.access_token);
 s.as('ok-second-applicant');const second=await s.login();const b=await s.call('POST','/v1/maintainer-applications',form,second.access_token);assert.equal(b.status,201);
 assert.equal((await s.call('POST',`/v1/maintainer-applications/${a.data.application.id}/decision`,{decision:'approve'},admin)).status,200);
 const denied=await s.call('POST',`/v1/maintainer-applications/${b.data.application.id}/decision`,{decision:'approve'},admin);assert.equal(denied.status,409);
 const accounts=await s.call('GET','/v1/maintainer-accounts',undefined,admin);assert.equal(accounts.data.accounts.length,1);
 const applications=await s.call('GET','/v1/maintainer-applications',undefined,admin);assert.equal(applications.data.applications[0].status,'pending');
});
