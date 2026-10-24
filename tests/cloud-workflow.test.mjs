import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {parseDelta,validateStandardQuestion,parseModelReply,sha256,deltaPackage} from '../shared/intake.ts';
import {readManifest,readSnapshot} from '../shared/sync.ts';
import {encodeUpload} from '../tools/encode-upload.mjs';

const require=createRequire(import.meta.url);
const {createHandler}=require('../cloud/qbank-auth/service.cjs');
const fixture=fs.readFileSync(new URL('./fixtures/intake/mobile-delta.json',import.meta.url),'utf8');
const {delta,questions}=parseDelta(fixture),id=delta.bank_id;
const key='b'.repeat(64);

function setup(){
  const states=new Map(),latest=new Map(),records=new Map();
  const env={WX_APP_ID:'wx0000000000000000',WX_APP_SECRET:'test',QBANK_SESSION_SECRET:'a'.repeat(64),
    QBANK_UPLOAD_ENABLED:'true',QBANK_SYNC_ENABLED:'true',QBANK_CLOUD_CREATORS:JSON.stringify(['maintainer-tests']),
    QBANK_BANKS:JSON.stringify([{bank_id:id,name:delta.name}]),
    QBANK_MAINTAINERS:JSON.stringify([{id:'maintainer-tests',key_sha256:sha256(key),grants:{[id]:['upload','merge']}}])};
  const store={
    async readState(bank){return latest.has(bank)?structuredClone(latest.get(bank)):null;},
    async readStateAt(bank,revision){const s=states.get(`${bank}/${revision}`);return s?structuredClone(s):null;},
    async listStates(bank){return [...states.values()].filter(s=>s.bank_id===bank).sort((a,b)=>b.revision-a.revision).map(s=>structuredClone(s));},
    async createState(state){const k=`${state.bank_id}/${state.revision}`;if(states.has(k))return false;const current=latest.get(state.bank_id);if(current&&current.revision>=state.revision)return false;states.set(k,structuredClone(state));latest.set(state.bank_id,structuredClone(state));return true;},
    async createSubmission(k,r){if(records.has(k))return {record:records.get(k),created:false};records.set(k,structuredClone(r));return {record:r,created:true};},
  };
  const handler=createHandler({env:()=>env,store,parseDelta,validateStandardQuestion,parseModelReply});
  const call=async(method,path,body,token)=>{const r=await handler({httpMethod:method,path,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.statusCode,data:JSON.parse(r.body)};};
  const login=async()=>(await call('POST','/v1/auth/desktop',{key})).data.access_token;
  return {call,login,store,states,records,env};
}

async function seed(s,token,extra={}){
  const base={...questions[0],question_id:randomUUID(),stem:'Initial base question',status:'verified',...extra};
  const result=await s.call('POST',`/v1/banks/${id}/seed`,{base_revision:0,questions:[base]},token);
  assert.equal(result.status,200,JSON.stringify(result.data));
  return base;
}

test('anonymous catalogue exposes only the current snapshot-v2 protocol',async()=>{
  const s=setup();
  assert.equal((await s.call('GET','/v1/catalog')).status,200);
  assert.equal((await s.call('POST','/v1/auth/wechat',{code:'removed'})).status,404);
  assert.equal((await s.call('POST','/v1/uploads',encodeUpload(fixture))).status,401);
});

test('one compressed Base64 upload is decoded, decompressed, merged, recompressed and versioned atomically',async()=>{
  const s=setup(),token=await s.login();
  const base=await seed(s,token);
  const response=await s.call('POST','/v1/uploads',encodeUpload(fixture),token);
  assert.equal(response.status,201,JSON.stringify(response.data));
  assert.equal(response.data.receipt.status,'merged');
  assert.equal(response.data.receipt.added_count,1);
  assert.equal(response.data.merged,true);
  const manifest=readManifest((await s.call('GET',`/v1/banks/${id}/manifest`)).data);
  assert.equal(manifest.revision,2);
  assert.equal(manifest.release_version,2);
  const fileResponse=await s.call('GET',`/v1/banks/${id}/snapshot-file`);assert.equal(fileResponse.status,200,JSON.stringify(fileResponse.data));
  const snapshot=readSnapshot(fileResponse.data,manifest);
  assert.equal(snapshot.formal.length,2);
  assert.equal(snapshot.pending.length,0);
  assert.equal(snapshot.formal.some(q=>q.question_id===base.question_id),true);
  assert.ok(manifest.release_name.includes('_合并_v2_'));
  assert.equal((await s.call('GET',`/v1/banks/${id}/history`,undefined,token)).status,200);
  assert.equal((await s.call('GET',`/v1/banks/${id}/history`,undefined,token)).data.versions.length,2);
  const duplicate=await s.call('POST','/v1/uploads',encodeUpload(fixture),token);
  assert.equal(duplicate.status,200);
  assert.equal(duplicate.data.receipt.status,'duplicate');
  assert.equal((await s.store.readState(id)).merge_history.length,1);
});

test('same batch is idempotent, bad content never partially merges, and old versions roll back',async()=>{
  const s=setup(),token=await s.login();
  const base=await seed(s,token);
  const changed={...questions[0],question_id:randomUUID(),stem:'新增后可回退的题目'};
  const text=deltaPackage(id,delta.name,randomUUID(),[changed],new Date().toISOString());
  assert.equal((await s.call('POST','/v1/uploads',encodeUpload(text),token)).status,201);
  let manifest=readManifest((await s.call('GET',`/v1/banks/${id}/manifest`)).data);
  assert.equal(manifest.release_version,2);
  const current=await s.store.readState(id);
  const rollback=await s.call('POST',`/v1/banks/${id}/rollback`,{operation_id:randomUUID(),base_revision:current.revision,target_revision:1},token);
  assert.equal(rollback.status,200,JSON.stringify(rollback.data));
  manifest=readManifest(rollback.data);
  const fileResponse=await s.call('GET',`/v1/banks/${id}/snapshot-file`);assert.equal(fileResponse.status,200,JSON.stringify(fileResponse.data));
  const snapshot=readSnapshot(fileResponse.data,manifest);
  assert.equal(snapshot.formal.length,1);
  assert.equal(snapshot.formal[0].question_id,base.question_id);
  assert.equal(snapshot.rollback_of,1);
  const conflict={...questions[0],question_id:randomUUID(),stem:'冲突批次'};
  const conflictText=deltaPackage(id,delta.name,randomUUID(),[conflict],new Date().toISOString());
  const packet=encodeUpload(conflictText);
  const altered={...packet,package:{...packet.package,sha256:'0'.repeat(64)}};
  assert.equal((await s.call('POST','/v1/uploads',altered,token)).status,422);
  assert.equal((await s.store.readState(id)).formal.some(q=>q.stem==='冲突批次'),false);
});

test('question validation remains strict while direct merge has no review queue',()=>{
  const reply={format:'qbank-photo-question-1',type:'single',stem:'Test',options:[{key:'A',content:'one'},{key:'B',content:'two'}],answer:['A'],answer_origin:'inferred',explanation:'',warnings:[],model:{name:'test',version:'1',version_source:'user'}};
  assert.throws(()=>parseModelReply(JSON.stringify({...reply,answer:['C']})));
  assert.throws(()=>validateStandardQuestion({...questions[0],status:'queued'},delta.name));
});

test('rollback after a bank rename keeps its current name and preserves the older immutable version',async()=>{
 const s=setup(),token=await s.login(),base=await seed(s,token);
 const previous=await s.store.readState(id),name='HarmonyOS 高级认证';
 const renamed={...structuredClone(previous),name,revision:2,release_version:2,
  formal:previous.formal.map(q=>({...q,bank:name,tags:[...q.tags,'06月25日录入']}))};
 renamed.release_id=sha256(JSON.stringify(renamed.formal));
 assert.equal(await s.store.createState(renamed),true);
 s.env.QBANK_BANKS=JSON.stringify([{bank_id:id,name}]);
 const current=readManifest((await s.call('GET',`/v1/banks/${id}/manifest`)).data);
 const snapshot=readSnapshot((await s.call('GET',`/v1/banks/${id}/snapshot-file`)).data,current);
 assert.equal(snapshot.name,name);assert.ok(snapshot.formal[0].tags.includes('06月25日录入'));
 const response=await s.call('POST',`/v1/banks/${id}/rollback`,{operation_id:randomUUID(),base_revision:2,target_revision:1},token);
 assert.equal(response.status,200,JSON.stringify(response.data));
 const restored=readSnapshot((await s.call('GET',`/v1/banks/${id}/snapshot-file`)).data,readManifest(response.data));
 assert.equal(restored.revision,3);assert.equal(restored.name,name);assert.deepEqual(restored.formal[0].options,base.options);
 assert.equal(restored.formal[0].bank,name);assert.equal(restored.formal[0].question_id,base.question_id);
 assert.equal(response.data.release_id,sha256(JSON.stringify([{...base,bank:name}])));
 assert.deepEqual(await s.store.readStateAt(id,1),previous);
});

test('conflicting answers reject the whole multi-question upload without a partial revision',async()=>{
 const s=setup(),token=await s.login();const base=await seed(s,token);
 const added={...questions[0],question_id:randomUUID(),stem:'本批新题'};
 const conflict={...questions[0],question_id:randomUUID(),stem:base.stem,answer:[base.options.find(o=>!base.answer.includes(o.key)).key]};
 const text=deltaPackage(id,delta.name,randomUUID(),[added,conflict],new Date().toISOString());
 const response=await s.call('POST','/v1/uploads',encodeUpload(text),token);
 assert.equal(response.status,409,JSON.stringify(response.data));assert.equal(response.data.error.code,'ANSWER_CONFLICT');
 const state=await s.store.readState(id);assert.equal(state.revision,1);assert.equal(state.formal.length,1);assert.equal(state.merge_history.length,0);
});

test('replaying a merged batch after another upload or rollback returns its original merge time and version',async()=>{
 const s=setup(),token=await s.login();await seed(s,token);
 const first=await s.call('POST','/v1/uploads',encodeUpload(fixture),token);assert.equal(first.status,201);
 const another=deltaPackage(id,delta.name,randomUUID(),[{...questions[0],question_id:randomUUID(),stem:'第二批新题'}],new Date().toISOString());
 assert.equal((await s.call('POST','/v1/uploads',encodeUpload(another),token)).status,201);
 for(const revision of [3,4]){
  if(revision===4)assert.equal((await s.call('POST',`/v1/banks/${id}/rollback`,{operation_id:randomUUID(),base_revision:3,target_revision:1},token)).status,200);
  const retry=await s.call('POST','/v1/uploads',encodeUpload(fixture),token);
  assert.equal(retry.status,200);assert.equal(retry.data.receipt.status,'duplicate');assert.equal(retry.data.version.revision,revision);
  for(const field of ['revision','release_version','release_name','merged_at','accepted_at'])assert.equal(retry.data.receipt[field],first.data.receipt[field],field);
  assert.equal((await s.store.readState(id)).revision,revision);
 }
 assert.equal((await s.store.readState(id)).formal.length,1);
});

test('reading flagged source material does not relax new-upload validation',async()=>{
 const unknown={...questions[0],status:'needs_review',issues:['源文档未提供答案'],answer:null};
 assert.doesNotThrow(()=>validateStandardQuestion(unknown,delta.name));
 assert.throws(()=>validateStandardQuestion({...unknown,status:'verified'},delta.name));
 const repeated={...questions[0],options:questions[0].options.map(o=>({...o,content:'重复选项'}))};
 assert.doesNotThrow(()=>validateStandardQuestion(repeated,delta.name));
 const s=setup(),token=await s.login();await seed(s,token);
 for(const question of [unknown,repeated]){
  const raw=deltaPackage(id,delta.name,randomUUID(),[question],new Date().toISOString());
  assert.throws(()=>encodeUpload(raw));
  const packet={format:'qbank-confirmed-upload-1',package:{format:'qbank-upload-1',encoding:'gzip+base64',uncompressed_size:Buffer.byteLength(raw),sha256:sha256(raw),data:gzipSync(Buffer.from(raw)).toString('base64')}};
  assert.equal((await s.call('POST','/v1/uploads',packet,token)).status,422);
 }
 assert.equal((await s.store.readState(id)).revision,1);
});

test('quality status repair creates one reversible version and never changes or fabricates question content',async()=>{
 const {repairBankStatus}=require('../tools/self-host/repair-bank-status.cjs');const {releaseName}=require('../cloud/qbank-auth/projection.cjs');
 const s=setup(),base={...questions[0],answer:null,status:'verified',issues:['原始资料没有答案']};
 const state={format:'qbank-state-1',bank_id:id,name:delta.name,revision:1,release_version:1,formal:[base],pending:[],resolved:[],batches:[],merge_history:[]};await s.store.createState(state);
 const run=()=>repairBankStatus({store:s.store,bankId:id,validateQuestion:validateStandardQuestion,releaseName});
 const result=await run();assert.equal(result.changed,1);assert.equal(result.revision,2);
 const current=await s.store.readState(id);assert.deepEqual(current.formal[0],{...base,status:'needs_review'});assert.equal((await s.store.readStateAt(id,1)).formal[0].status,'verified');
 assert.equal((await run()).changed,0);assert.equal((await s.store.listStates(id)).length,2);
 const invalid=setup();await invalid.store.createState({...state,formal:[{...base,stem:''}]});
 await assert.rejects(()=>repairBankStatus({store:invalid.store,bankId:id,validateQuestion:validateStandardQuestion,releaseName}));assert.equal((await invalid.store.listStates(id)).length,1);
});
