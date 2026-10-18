import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import * as queue from '../shared/queue.ts';
import {randomUUID} from 'node:crypto';
import * as sync from '../shared/sync.ts';
import {sha256} from '../shared/intake.ts';

const bank='ad50971f-66af-51c2-bb0e-dc798b03b369';
const payload=JSON.stringify({format:'qbank-snapshot-1',bank_id:bank,name:'测试库',revision:1,release_version:1,updated_at:'2026-10-17T00:00:00Z',formal:[],pending:[],removed:[]});
const wrapper={payload,sha256:sha256(payload)};
const manifest={bank_id:bank,name:'测试库',revision:1,release_version:1,updated_at:'2026-10-17T00:00:00Z',minimum_client:'0.2.7',bytes:Buffer.byteLength(payload),sha256:wrapper.sha256};
const pause=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function client(invoke, state=new Map(), storage=new Map()){
 const module={exports:{}};
 const native=invoke;invoke=async(command,args)=>{if(command==='client_state'){if(args.value!==null)state.set(args.key,structuredClone(args.value));return structuredClone(state.get(args.key)||null);}return native(command,args)};
 const root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map();
 const context=vm.createContext({BUILD_ENV:{DEV:false},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},URL,Date,Map,Promise,crypto:{randomUUID},window:{dispatchEvent(){}},Event:class {}});
 function load(file){
  file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
  const entry={exports:{}};cache.set(file,entry);
  const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env','BUILD_ENV');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const require=name=>name==='@tauri-apps/api/core'?{invoke}:name.endsWith('shared/queue')?queue:name.endsWith('shared/sync')?sync:load(path.resolve(path.dirname(file),name+'.ts'));
  vm.runInContext('(function(module,exports,require){'+compiled+'\n})',context)(entry,entry.exports,require);return entry.exports;
 }
 module.exports=load(path.join(root,'src/cloud-client.ts'));
 module.exports.setCloudOrigin('https://first.example');return module.exports;
}
test('desktop anonymous sync coalesces requests and rejects corrupt, rolled back or altered revisions before writing',async()=>{
 let mode='ok',saved=[],versions=[];const calls=[];
 const c=client(async(command,args)=>{
  calls.push(command);if(command==='cloud_versions')return versions;
  if(command==='cloud_apply'){saved.push(args);return;}
  return {status:200,body:args.path.endsWith('/manifest')?manifest:mode==='corrupt'?{...wrapper,payload:payload+' '}:wrapper};
 });
 const a=c.syncDesktop(bank),b=c.syncDesktop(bank);assert.equal(a,b);assert.equal(await a,true);assert.equal(saved.length,1);
 assert.equal(calls.filter(x=>x==='cloud_request').length,2);
 versions=[{bank_id:bank,revision:1,sha256:wrapper.sha256}];assert.equal(await c.syncDesktop(bank),false);
 versions=[{bank_id:bank,revision:2,sha256:wrapper.sha256}];await assert.rejects(c.syncDesktop(bank),/版本倒退/);
 versions=[{bank_id:bank,revision:1,sha256:'0'.repeat(64)}];await assert.rejects(c.syncDesktop(bank),/同版本内容/);
 versions=[];mode='corrupt';await assert.rejects(c.syncDesktop(bank),/摘要校验失败/);assert.equal(saved.length,1);
});
test('changing desktop service while a snapshot downloads cancels the old apply and does not block the new service',async()=>{
 const downloading=pause(),response=pause();let applied=0;
 const c=client(async(command,args)=>{
  if(command==='cloud_versions')return [];
  if(command==='cloud_apply'){applied++;return;}
  if(args.path.endsWith('/manifest'))return {status:200,body:manifest};
  if(args.origin==='https://first.example'){downloading.resolve();await response.promise;}
  return {status:200,body:wrapper};
 });
 const old=c.syncDesktop(bank),rejected=assert.rejects(old,/服务地址已改变/);await downloading.promise;
 c.setCloudOrigin('https://second.example');assert.equal(await c.syncDesktop(bank),true);
 response.resolve();await rejected;assert.equal(applied,1);
});
test('desktop logout cancels an in-flight login and never restores its session',async()=>{
 const requested=pause(),response=pause();let calls=0;
 const c=client(async()=>{calls++;requested.resolve();await response.promise;return {status:200,body:{access_token:'v1.dGVzdA.c2lnbmF0dXJl',expires_in:900}};});
 const login=c.cloudLogin('test-maintainer-secret'),rejected=assert.rejects(login,/登录响应无效/);
 await requested.promise;c.cloudLogout();response.resolve();await rejected;
 assert.equal(c.cloudAccess(),undefined);assert.equal(calls,1);
});
test('review history derives from snapshots while offline drafts and receipt states remain independent',()=>{
 const snapshot=JSON.parse(payload);snapshot.removed=[{question_id:'first',status:'merged'},{question_id:'second',status:'rejected'}];
 let states=sync.reviewStates(snapshot);assert.equal(states.get('first'),'merged');assert.equal(states.get('second'),'rejected');assert.equal(states.get('local-draft'),undefined);
 snapshot.pending=[{question_id:'second'}];states=sync.reviewStates(snapshot);assert.equal(states.get('second'),'pending');
 assert.equal(sync.reviewStates(null).size,0);
});

test('desktop confirmed queue retries the same frozen transfer after reopening and stops on logout or changed identity',async()=>{
 const state=new Map(),storage=new Map(),sent=[],receipts=[];let lost=true,actor='maintainer-a';
 const invoke=async(command,args)=>{
  if(command==='draft_records')return [{id:'q1',revision:1,submissionId:''},{id:'q2',revision:3,submissionId:''}];
  if(command==='draft_submit'){assert.deepEqual(JSON.parse(JSON.stringify(args.expected)),[{id:'q1',revision:1},{id:'q2',revision:3}]);const job={id:'session-one',groupId:'session-one',bankId:bank,endpoint:args.endpoint,actor:args.actor,confirmedAt:new Date().toISOString(),status:'queued',attempts:0,nextAt:0,error:''};state.set('upload-queue',[job]);return job;}
  if(command==='cloud_transfer')return {envelope:{frozen:args.batchId},receipt:null};
  if(command==='cloud_receipt'){receipts.push(args);return;}
  if(command==='cloud_versions')return [];
  if(command==='cloud_request'){
   if(args.path==='/v1/auth/desktop')return {status:200,body:{access_token:'v1.test.signature',expires_in:900}};
   if(args.path==='/v1/me')return {status:200,body:{openid:actor,banks:[{bank_id:bank,name:'测试库'}],grants:{[bank]:['upload']},uploads_enabled:true}};
   if(args.path==='/health')return {status:200,body:{capabilities:['confirmed-upload-v1','session-upload-v1']}};
   if(args.path==='/v1/uploads'){sent.push(args.body);if(lost){lost=false;throw Error('NETWORK: lost response');}return {status:200,body:{receipt:{batch_id:args.body.package.frozen}}};}
   return {status:503,body:{error:{message:'sync offline'}}};
  }
  throw Error(command);
 };
 const c=client(invoke,state,storage);await c.cloudLogin('test-maintainer-key');await c.enqueueDesktop(['local-group'],bank);
 assert.equal(sent.length,0);assert.equal((await c.desktopJobs()).length,1);await c.runDesktopQueue();
 assert.equal((await c.desktopJobs()).filter(j=>j.status==='done').length,0);
 const reopened=client(invoke,state,storage);await reopened.cloudLogin('test-maintainer-key');await reopened.retryDesktopJobs();await reopened.runDesktopQueue();
 assert.ok((await reopened.desktopJobs()).every(j=>j.status==='done'));assert.deepEqual(sent.map(s=>s.package.frozen),['session-one','session-one']);assert.ok(sent.every(s=>s.format==='qbank-confirmed-upload-1'));
 state.get('upload-queue')[0].status='queued';reopened.cloudLogout();await reopened.pauseDesktopJobs();const count=sent.length;await reopened.runDesktopQueue();assert.equal(sent.length,count);
 actor='maintainer-b';await reopened.cloudLogin('another-test-key');await reopened.retryDesktopJobs();await reopened.runDesktopQueue();assert.equal(sent.length,count);assert.equal((await reopened.desktopJobs())[0].status,'paused');assert.equal(receipts.length,1);
});

test('remembering a desktop key uses native credentials and forgetting it leaves the queue intact',async()=>{
 const storage=new Map(),state=new Map([['upload-queue',[{id:'existing',status:'done'}]]]),native=[];
 const c=client(async(command,args)=>{
  if(command==='credential_save'){native.push(args);return;}
  if(command==='credential_login')return {status:200,body:{access_token:'v1.test.signature',expires_in:900}};
  return {status:200,body:args.path.endsWith('/desktop')?{access_token:'v1.test.signature',expires_in:900}:{openid:'a',banks:[],grants:{},uploads_enabled:true}};
 },state,storage);
 await c.cloudLogin('test-only-private-key',true);assert.equal(c.remembersMachine(),true);assert.equal(native[0].key,'test-only-private-key');
 assert.ok(!JSON.stringify([...storage,...state]).includes('test-only-private-key'));
 c.setCloudOrigin('https://second.example');assert.equal(c.remembersMachine(),false);c.setCloudOrigin('https://first.example');assert.ok(await c.resumeDesktop());
 await c.cloudForget();assert.equal(native.at(-1).key,null);assert.equal(c.remembersMachine(),false);assert.equal((await c.desktopJobs())[0].id,'existing');
});
