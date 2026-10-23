import {packText,unpackText} from '../shared/codec.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {parseDelta,validateStandardQuestion,parseModelReply,sha256,deltaPackage,reorderOptions,changeQuestionType} from '../shared/intake.ts';
import {readManifest,readSnapshot,combineLayers} from '../shared/sync.ts';
import {encodeUpload} from '../tools/cloud/encode-upload.mjs';
const require=createRequire(import.meta.url),{createHandler}=require('../cloud/qbank-auth/service.cjs');
const fixture=fs.readFileSync(new URL('./fixtures/intake/mobile-delta.json',import.meta.url),'utf8'),{delta,questions}=parseDelta(fixture),id=delta.bank_id;
function setup(){
 const states=new Map(),records=new Map(),key='b'.repeat(64),otherKey='c'.repeat(64);
 const env={WX_APP_ID:'wx0000000000000000',WX_APP_SECRET:'test',QBANK_SESSION_SECRET:'a'.repeat(64),QBANK_UPLOAD_ENABLED:'true',QBANK_SYNC_ENABLED:'true',
  QBANK_CLOUD_CREATORS:JSON.stringify(['maintainer-tests']),QBANK_BANKS:JSON.stringify([{bank_id:id,name:delta.name}]),QBANK_DEVELOPERS:JSON.stringify({'openid-developer-tests':[id]}),
  QBANK_MAINTAINERS:JSON.stringify([{id:'maintainer-tests',key_sha256:sha256(key),grants:{[id]:['upload','review','publish']}},{id:'upload-only-tests',key_sha256:sha256(otherKey),grants:{[id]:['upload']}}])};
 const store={async readState(bank){const s=[...states.values()].filter(s=>s.bank_id===bank).sort((a,b)=>b.revision-a.revision)[0];return s?structuredClone(s):null;},
  async readStateAt(bank,revision){const s=states.get(bank+'/'+revision);return s?structuredClone(s):null;},
  async listStates(bank){return [...states.values()].filter(s=>s.bank_id===bank).sort((a,b)=>b.revision-a.revision).map(s=>structuredClone(s));},
  async createState(s){const k=s.bank_id+'/'+s.revision;if(states.has(k))return false;states.set(k,structuredClone(s));return true;},
  async createSubmission(k,r){if(records.has(k))return {record:records.get(k),created:false};records.set(k,r);return {record:r,created:true};}};
 const handler=createHandler({env:()=>env,store,parseDelta,validateStandardQuestion,parseModelReply,exchangeCode:async()=>({openid:'openid-developer-tests'})});
 const call=async(method,path,body,token)=>{const r=await handler({httpMethod:method,path,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.statusCode,data:JSON.parse(r.body)};};
 const login=async(k=key)=>(await call('POST','/v1/auth/desktop',{key:k})).data.access_token;
 return {call,login,env,store,states,records,otherKey};
}
test('anonymous catalogue, per-bank desktop roles and immediate revocation',async()=>{
 const s=setup(),token=await s.login(s.otherKey);
 assert.equal((await s.call('GET','/v1/catalog')).status,200);
 assert.equal((await s.call('POST',`/v1/banks/${id}/seed`,{base_revision:0,questions},token)).status,403);
 assert.equal((await s.call('POST','/v1/uploads',encodeUpload(fixture))).status,401);
 const me=await s.call('GET','/v1/me',undefined,token);assert.deepEqual(me.data.grants[id],['upload']);
 s.env.QBANK_MAINTAINERS='[]';s.env.QBANK_CLOUD_CREATORS='[]';assert.equal((await s.call('GET','/v1/me',undefined,token)).status,403);
});
test('upload decodes, validates and merges immediately with public privacy',async()=>{
 const s=setup(),token=await s.login();
 const base={...questions[0],question_id:randomUUID(),stem:'Initial base question',status:'verified'};
 assert.equal((await s.call('POST',`/v1/banks/${id}/seed`,{base_revision:0,questions:[base]},token)).status,200);
 const upload=await s.call('POST','/v1/uploads',encodeUpload(fixture),token);assert.equal(upload.status,201);
 const m=readManifest((await s.call('GET',`/v1/banks/${id}/manifest`)).data),w=(await s.call('GET',`/v1/banks/${id}/snapshot`)).data;
 const snapshot=readSnapshot(w,m);assert.equal(snapshot.pending.length,0);assert.equal(snapshot.formal.length,2);
 assert.ok(!w.payload.includes('submitted_by'));assert.ok(w.payload.includes('recorded_at'));assert.ok(!w.payload.includes('confirmed_at'));assert.ok(!w.payload.includes('reviewer'));
 const p=(await s.call('GET',`/v1/banks/${id}/candidates`,undefined,token)).data;
 assert.equal(p.candidates.length,0);
 const after=readSnapshot((await s.call('GET',`/v1/banks/${id}/snapshot`)).data,m);
 assert.equal(after.pending.length,0);assert.equal(after.formal.length,2);assert.equal(after.removed.at(-1).status,'merged');
 const retry=await s.call('POST','/v1/uploads',encodeUpload(fixture),token);assert.equal(retry.status,200);assert.equal((await s.store.readState(id)).pending.length,0);
 const local={...questions[0],question_id:randomUUID(),stem:'Private local draft'};
 assert.equal(combineLayers(after.formal,after.pending,[questions[0],local]).length,3);
});
test('concurrent writers cannot overwrite; merge persists and corrupt snapshots never apply',async()=>{
 const s=setup(),token=await s.login();
 const seed={base_revision:0,questions};
 const both=await Promise.all([s.call('POST',`/v1/banks/${id}/seed`,seed,token),s.call('POST',`/v1/banks/${id}/seed`,seed,token)]);
 assert.deepEqual(both.map(r=>r.status).sort(),[200,409]);
 const q={...questions[0],question_id:randomUUID(),stem:'Candidate to reject'},text=deltaPackage(id,delta.name,randomUUID(),[q],new Date().toISOString());
 await s.call('POST','/v1/uploads',encodeUpload(text),token);
 const state=await s.store.readState(id);
 assert.equal(state.pending.length,0);assert.ok(state.formal.some(q=>q.stem==='Candidate to reject'));
 const m=readManifest((await s.call('GET',`/v1/banks/${id}/manifest`)).data),w=(await s.call('GET',`/v1/banks/${id}/snapshot`)).data;
 assert.equal(readSnapshot(w,m).pending.length,0);
 assert.throws(()=>readSnapshot({...w,payload:w.payload+' '},m));
 assert.throws(()=>readSnapshot(w,{...m,bank_id:randomUUID()}));
 await s.call('POST','/v1/uploads',encodeUpload(text),token);assert.equal((await s.store.readState(id)).pending.length,0);
});
test('editing options preserves answer content, deletion and type changes require new answer',()=>{
 const reply={format:'qbank-photo-question-1',type:'single',stem:'Test',options:[{key:'A',content:'one'},{key:'B',content:'two'}],answer:['A'],answer_origin:'inferred',explanation:'',warnings:[],model:{name:'test',version:'1',version_source:'user'}};
 const moved=reorderOptions(reply,[1,0]);assert.deepEqual(moved.answer,['B']);
 assert.throws(()=>parseModelReply(JSON.stringify(reorderOptions(reply,[1]))));
 assert.throws(()=>parseModelReply(JSON.stringify(changeQuestionType(reply,'true_false'))));
});
test('all historical seed questions survive public projection with unresolved answers and safe provenance',async()=>{
 const s=setup(),token=await s.login();
 const seed=JSON.parse(fs.readFileSync(new URL('../src-tauri/resources/seed.json',import.meta.url),'utf8')).map(q=>({external_id:'',chapter:'',explanation:'',difficulty:'',applicable_version:'',source_note:'',...q,bank:delta.name,options:q.options.map(o=>({...o,option_id:o.option_id||randomUUID()}))}));
 const result=await s.call('POST',`/v1/banks/${id}/seed`,{base_revision:0,questions:seed},token);
 assert.equal(result.status,200,JSON.stringify(result.data));
 const w=(await s.call('GET',`/v1/banks/${id}/snapshot`)).data,snapshot=readSnapshot(w,readManifest(result.data));
 assert.equal(snapshot.formal.length,seed.length);assert.ok(seed.some(q=>q.status==='needs_review'));
 assert.deepEqual(snapshot.formal.map(q=>q.answer),seed.map(q=>q.answer));assert.ok(!w.payload.includes('raw_text'));
 for(const q of snapshot.formal.filter(q=>q.answer===null))assert.ok(q.sources.length);
 const broken=structuredClone(seed[0]);broken.difficulty='impossible';assert.throws(()=>validateStandardQuestion(broken,delta.name,true));
});

test('COS state adapter orders immutable revisions, detects races and refuses versioned or corrupt storage',async()=>{
 const {createCosStore}=require('../cloud/qbank-auth/adapters.cjs');
 const objects=new Map();let versioning='',corrupt=false,lastList;
 const cos={getBucketVersioning:async()=>({VersioningConfiguration:versioning?{Status:versioning}:{}}),
  async putObject(p){assert.equal(p.Headers['x-cos-forbid-overwrite'],'true');if(objects.has(p.Key))throw {statusCode:409,code:'FileAlreadyExists'};objects.set(p.Key,p.Body);},
  async getBucket(p){lastList=p;return {Contents:[...objects.keys()].filter(k=>k.startsWith(p.Prefix)).sort().slice(0,p.MaxKeys).map(Key=>({Key}))};},
  async getObject(p){return {Body:corrupt?Buffer.from('bad json'):objects.get(p.Key)};}};
 const store=createCosStore({clientFactory:()=>cos,env:()=>({COS_RELEASE_BUCKET:'qbank-release-1324463245',COS_REGION:'ap-guangzhou'})});
 assert.equal(await store.readState(id),null);
 const state={format:'qbank-state-1',bank_id:id,revision:1};
 assert.deepEqual(await Promise.all([store.createState(state),store.createState(state)]),[true,false]);
 await store.createState({...state,revision:2});assert.equal((await store.readState(id)).revision,2);
 assert.equal(lastList.Prefix,`states/${id}/`);assert.equal(lastList.MaxKeys,1);
 for(const value of ['Enabled','Suspended']){versioning=value;await assert.rejects(store.createState({...state,revision:3}),/never/);}
 assert.equal(objects.size,2);corrupt=true;await assert.rejects(store.readState(id));
});

test('confirmed upload goes straight to merge, binds the actor, keeps time/name across operation retries and no-op merges',async()=>{
 const s=setup(),token=await s.login(),uploadOnly=await s.login(s.otherKey),route=`/v1/banks/${id}`;
 const base={...questions[0],question_id:randomUUID(),stem:'Time test baseline'};
 await s.call('POST',route+'/seed',{base_revision:0,questions:[base]},token);
 const packet=encodeUpload(fixture),confirmed={format:'qbank-confirmed-upload-1',package:packet};
 assert.equal((await s.call('POST','/v1/uploads',confirmed,token)).status,201);
 assert.equal((await s.call('POST','/v1/uploads',confirmed,uploadOnly)).status,409);
 let state=await s.store.readState(id);assert.equal(state.pending.length,0);assert.equal(state.merge_history.length,1);
 const merged=(await s.call('GET',route+'/manifest')).data;assert.match(merged.release_name,/\d{8}-\d{9}\+0800_.*_合并_v2_/);
 const history=(await s.call('GET',route+'/history',undefined,token)).data;assert.equal(history.versions.length,2);assert.equal(history.versions[0].revision,merged.revision);
 const rollback=await s.call('POST',route+'/rollback',{operation_id:randomUUID(),base_revision:state.revision,target_revision:1},token);assert.equal(rollback.status,200);assert.equal(rollback.data.release_version,1);
 const rolled=readSnapshot((await s.call('GET',route+'/snapshot')).data,rollback.data);
 assert.equal(rolled.formal.length,1);assert.equal(rolled.rollback_of,1);
 const w=(await s.call('GET',route+'/snapshot')).data,snapshot=readSnapshot(w,rollback.data);
 assert.equal(snapshot.formal.find(q=>q.question_id===base.question_id).sources[0].recorded_at,base.sources[0].recorded_at);
 assert.ok(!w.payload.includes('confirmation'));assert.equal(snapshot.pending.length,0);
 const duplicate=deltaPackage(id,delta.name,randomUUID(),[base],new Date().toISOString());
 await s.call('POST','/v1/uploads',{format:'qbank-confirmed-upload-1',package:encodeUpload(duplicate)},token);
 state=await s.store.readState(id);assert.equal(state.pending.length,0);assert.equal(state.merge_history.length,2);
 const noop=(await s.call('GET',route+'/manifest')).data;assert.equal(noop.release_version,rollback.data.release_version);assert.equal(noop.release_name,rollback.data.release_name);
});
test('legacy submissions cannot be upgraded by resending confirmed and quarantined test batches stay private',async()=>{
 const s=setup(),token=await s.login();await s.call('POST',`/v1/banks/${id}/seed`,{base_revision:0,questions:[{...questions[0],question_id:randomUUID(),stem:'Baseline'}]},token);
 const first=await s.call('POST','/v1/uploads',encodeUpload(fixture),token);assert.equal(first.data.receipt.status,'merged');
 const res=await s.call('POST','/v1/uploads',{format:'qbank-confirmed-upload-1',package:encodeUpload(fixture)},token);
 assert.equal(res.status,200);assert.equal(res.data.receipt.status,'duplicate');
 let state=await s.store.readState(id);assert.equal(state.pending.length,0);
 const packet=deltaPackage(id,delta.name,'770cb0d2-b0db-4a52-ae91-98df473d20f5',[{...questions[0],question_id:randomUUID(),stem:'never public'}],new Date().toISOString());
 await s.call('POST','/v1/uploads',{format:'qbank-confirmed-upload-1',package:encodeUpload(packet)},token);
 assert.ok(!(await s.call('GET',`/v1/banks/${id}/snapshot`)).data.payload.includes('never public'));
});

test('cloud creation requires explicit desktop capability, verifies first state before directory activation and retries the same task',async()=>{
 const s=setup(),admin=await s.login(),uploader=await s.login(s.otherKey),bank=randomUUID();
 const q={...questions[0],bank:'新云库'},body={operation_id:randomUUID(),package:packText(JSON.stringify({bank_id:bank,name:'新云库',questions:[q]}))};
 assert.equal((await s.call('POST','/v1/banks/promote',body,uploader)).status,403);
 const wx=(await s.call('POST','/v1/auth/wechat',{code:'new-code'})).data.access_token;
 assert.equal((await s.call('POST','/v1/banks/promote',{...body,platform:'desktop'},wx)).status,403);
 s.env.QBANK_CLOUD_CREATORS='[]';assert.equal((await s.call('POST','/v1/banks/promote',body,admin)).status,403);
 s.env.QBANK_CLOUD_CREATORS='["maintainer-tests"]';
 const create=s.store.createState;let failRegistry=true;
 s.store.createState=async state=>{if(state.bank_id.startsWith('00000000-0000-0000')&&failRegistry)throw Error('COS temporarily unavailable');return create(state)};
 assert.equal((await s.call('POST','/v1/banks/promote',body,admin)).status,500);
 assert.ok(await s.store.readState(bank));assert.ok(!(await s.call('GET','/v1/catalog')).data.banks.some(b=>b.bank_id===bank));
 failRegistry=false;const success=await s.call('POST','/v1/banks/promote',body,admin);assert.equal(success.status,200,JSON.stringify(success));assert.equal(success.data.revision,1);
 assert.deepEqual(await s.call('POST','/v1/banks/promote',body,admin),success);
 assert.equal(s.states.size,2);assert.equal((await s.call('POST','/v1/banks/promote',{...body,operation_id:randomUUID()},admin)).status,409);
 const me=(await s.call('GET','/v1/me',undefined,admin)).data;assert.deepEqual(me.grants[bank],['upload','merge']);
 const envelope=(await s.call('GET',`/v1/banks/${bank}/snapshot-file`)).data;
 assert.equal(envelope.encoding,'gzip+base64');assert.equal(JSON.parse(unpackText(envelope)).formal[0].stem,q.stem);
 assert.equal(readSnapshot(envelope,success.data).formal.length,1);
});
