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
import {packText} from '../shared/codec.ts';

const bank='ad50971f-66af-51c2-bb0e-dc798b03b369';
const payload=JSON.stringify({format:'qbank-snapshot-2',bank_id:bank,name:'测试库',revision:1,release_version:1,updated_at:'2026-10-17T00:00:00Z',formal:[],pending:[],removed:[]});
const wrapper=packText(payload);
const manifest={bank_id:bank,name:'测试库',revision:1,release_version:1,updated_at:'2026-10-17T00:00:00Z',minimum_client:'0.2.7',protocol:2,snapshot_format:'qbank-cloud-file-1',bytes:Buffer.byteLength(payload),sha256:wrapper.sha256};
const pause=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function client(invoke, state=new Map(), storage=new Map(), initialOrigin='https://first.example'){
 const module={exports:{}};
 const native=invoke;invoke=async(command,args)=>{if(command==='client_state'){if(args.value!==null)state.set(args.key,structuredClone(args.value));return structuredClone(state.get(args.key)||null);}return native(command,args)};
 const root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map();
 const context=vm.createContext({BUILD_ENV:{DEV:false},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},URL,Date,Map,Promise,crypto:{randomUUID},window:{dispatchEvent(){}},Event:class {}});
 function load(file){
  file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
  const entry={exports:{}};cache.set(file,entry);
  const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env','BUILD_ENV');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  const require=name=>name==='@tauri-apps/api/core'?{invoke}:name.endsWith('shared/queue')?queue:name.endsWith('shared/sync')?sync:name.endsWith('.json')?JSON.parse(fs.readFileSync(path.resolve(path.dirname(file),name),'utf8')):load(path.resolve(path.dirname(file),name+'.ts'));
  vm.runInContext('(function(module,exports,require){'+compiled+'\n})',context)(entry,entry.exports,require);return entry.exports;
 }
 module.exports=load(path.join(root,'src/cloud-client.ts'));
 if(initialOrigin)module.exports.setCloudOrigin(initialOrigin);return module.exports;
}

test('desktop discovers absent cloud banks over the default IP and reuses catalog manifests without downloading unchanged banks',async()=>{
 const second='c86104f7-4570-4089-9338-7989ce528a9d',calls=[],saved=[],versions=[];let offline=false;
 const text=JSON.stringify({...JSON.parse(payload),bank_id:second,name:'高级题库'}),packed=packText(text);
 const next={...manifest,bank_id:second,name:'高级题库',bytes:Buffer.byteLength(text),sha256:packed.sha256};
 const c=client(async(command,args)=>{
  if(command==='cloud_versions')return versions;
  if(command==='cloud_apply'){saved.push(args);const snapshot=JSON.parse(args.payload);versions.push({bank_id:snapshot.bank_id,revision:snapshot.revision,sha256:args.sha256});return;}
  assert.equal(command,'cloud_request');assert.equal(args.origin,'https://8.141.124.97:8013');calls.push(args.path);
  if(offline)throw Error('NETWORK: offline');
  return {status:200,body:args.path==='/v1/catalog'?{banks:[manifest,next]}:args.path.includes(second)?packed:wrapper};
 },new Map(),new Map(),null);
 const first=c.syncDesktopCatalog();assert.equal(c.syncDesktopCatalog(),first);
 const result=await first;assert.equal(result.changed,true);assert.equal(result.failed.length,0);
 assert.equal(saved.length,2);assert.ok(saved.some(s=>JSON.parse(s.payload).bank_id===second));
 assert.equal(calls.filter(p=>p.endsWith('/manifest')).length,0);
 assert.equal((await c.syncDesktopCatalog()).changed,false);assert.equal(saved.length,2);
 assert.equal(calls.filter(p=>p.endsWith('/snapshot-file')).length,2);
 offline=true;await assert.rejects(c.syncDesktopCatalog(),/offline/);
 assert.equal(saved.length,2);assert.equal(versions.length,2);
});

test('one desktop bank failing validation does not prevent discovery of another bank',async()=>{
 const second='c86104f7-4570-4089-9338-7989ce528a9d',saved=[];
 const text=JSON.stringify({...JSON.parse(payload),bank_id:second,name:'高级题库'}),packed=packText(text);
 const next={...manifest,bank_id:second,name:'高级题库',bytes:Buffer.byteLength(text),sha256:packed.sha256};
 const c=client(async(command,args)=>{
  if(command==='cloud_versions')return [];
  if(command==='cloud_apply'){saved.push(args);return;}
  return {status:200,body:args.path==='/v1/catalog'?{banks:[manifest,next]}:args.path.includes(second)?packed:packText(payload+' ')};
 });
 const result=await c.syncDesktopCatalog();assert.equal(result.changed,true);assert.deepEqual([...result.failed],['测试库（Error: 云端题库摘要校验失败）']);
 assert.equal(saved.length,1);assert.equal(JSON.parse(saved[0].payload).bank_id,second);
});
test('desktop anonymous sync coalesces requests, rejects corrupt or rolled back snapshots and repairs same-revision digest changes',async()=>{
 let mode='ok',saved=[],versions=[];const calls=[];
 const c=client(async(command,args)=>{
  calls.push(command);if(command==='cloud_versions')return versions;
  if(command==='cloud_apply'){saved.push(args);return;}
  return {status:200,body:args.path.endsWith('/manifest')?manifest:mode==='corrupt'?packText(payload+' '):wrapper};
 });
 const a=c.syncDesktop(bank),b=c.syncDesktop(bank);assert.equal(a,b);assert.equal(await a,true);assert.equal(saved.length,1);
 assert.equal(calls.filter(x=>x==='cloud_request').length,2);
 versions=[{bank_id:bank,revision:1,sha256:wrapper.sha256}];assert.equal(await c.syncDesktop(bank),false);
 versions=[{bank_id:bank,revision:2,sha256:wrapper.sha256}];await assert.rejects(c.syncDesktop(bank),/版本倒退/);
 versions=[{bank_id:bank,revision:1,sha256:'0'.repeat(64)}];assert.equal(await c.syncDesktop(bank),true);assert.equal(saved.length,2);
 versions=[];mode='corrupt';await assert.rejects(c.syncDesktop(bank),/摘要校验失败/);assert.equal(saved.length,2);
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
test('desktop accepts only compressed current snapshots and rejects review candidates',()=>{
 assert.throws(()=>sync.readSnapshot({payload,sha256:wrapper.sha256},manifest),/封装无效/);
 const rejected=JSON.stringify({...JSON.parse(payload),pending:[{question_id:'candidate'}]});
 const packed=packText(rejected);
 assert.throws(()=>sync.readSnapshot(packed,{...manifest,sha256:packed.sha256,bytes:Buffer.byteLength(rejected)}));
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
