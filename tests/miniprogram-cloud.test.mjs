import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import ts from 'typescript';
import {parseDelta,validateStandardQuestion,parseModelReply,deltaPackage,toQuestion,sha256} from '../shared/intake.ts';
const require=createRequire(import.meta.url);
const {createHandler,decodeUpload}=require('../cloud/qbank-auth/service.cjs');
const root=fileURLToPath(new URL('../miniprogram/miniprogram/',import.meta.url));
const fixture=fs.readFileSync(new URL('fixtures/intake/mobile-delta.json',import.meta.url),'utf8');
const modelReply={format:'qbank-photo-question-1',type:'single',stem:'云端录题 🧪',options:[{key:'A',content:'中文'},{key:'B',content:'英文'}],answer:['A'],answer_origin:'inferred',explanation:'用于自动测试。',model:{name:'测试模型',version:'test-1',version_source:'user'},warnings:[]};

function server(){
 const records=new Map(),states=new Map(),env={WX_APP_ID:'wx22c8135ae81d3acc',WX_APP_SECRET:'only-for-test',QBANK_SESSION_SECRET:'a'.repeat(64),
  QBANK_BANKS:'[]',QBANK_DEVELOPERS:'{}',QBANK_UPLOAD_ENABLED:'true'};
 const handle=createHandler({env:()=>env,parseDelta,validateStandardQuestion,parseModelReply,exchangeCode:async()=>({openid:'test-developer-openid'}),
  store:{readState:async id=>states.get(id)||null,createState:async state=>{const old=states.get(state.bank_id);if(old&&old.revision>=state.revision)return false;states.set(state.bank_id,structuredClone(state));return true;},createSubmission:async(key,record)=>{const previous=records.get(key);if(previous)return {record:previous,created:false};records.set(key,record);return {record,created:true};}}});
 return {env,records,states,allow(bank_id,name){env.QBANK_BANKS=JSON.stringify([{bank_id,name}]);env.QBANK_DEVELOPERS=JSON.stringify({'test-developer-openid':[bank_id]});},handle};
}
function mobile(s=server(),disk=new Map()){
 const modules=new Map(),calls=[],storage=new Map();let broken=false,mode='ok',environment='develop',capturedPage;
 const wx={env:{USER_DATA_PATH:'/local'},getAccountInfoSync:()=>({miniProgram:{appId:'wx22c8135ae81d3acc',envVersion:environment}}),
  getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),
  getRandomValues:o=>{const b=randomBytes(o.length);o.success({randomValues:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)});},
  login:o=>{calls.push('wx.login');o.success({code:'test-new-code'});},
  request:o=>{const url=new URL(o.url);calls.push(url.pathname);if(mode==='offline'){o.fail({errMsg:'offline'});return;}
    void s.handle({httpMethod:o.method,path:url.pathname,headers:o.header,body:o.data}).then(r=>{
      if(url.pathname==='/v1/uploads'&&mode==='lose-response'){mode='ok';o.fail({errMsg:'timeout'});return;}
      if(url.pathname==='/v1/uploads'&&mode==='disk-full')broken=true;
      const data=JSON.parse(r.body);if(mode==='corrupt'&&url.pathname.endsWith('/snapshot'))data.payload+=' ';
      if(url.pathname==='/v1/uploads'&&mode==='bad-receipt'&&data.receipt)data.receipt.bank_id=randomUUID();
      o.success({statusCode:r.statusCode,data});
    });},
  getFileSystemManager:()=>({
   readFile:o=>disk.has(o.filePath)?o.success({data:disk.get(o.filePath)}):o.fail({errMsg:`readFile:fail ${o.filePath} not found`}),
   writeFile:o=>broken?o.fail({errMsg:'disk full'}):(disk.set(o.filePath,o.data),o.success()),
   rename:o=>{disk.set(o.newPath,disk.get(o.oldPath));disk.delete(o.oldPath);o.success();}})};
 function load(relative){
  const absolute=path.resolve(root,relative),filename=fs.existsSync(absolute+'.ts')?absolute+'.ts':fs.existsSync(absolute+'.js')?absolute+'.js':absolute;
  if(modules.has(filename))return modules.get(filename).exports;
  const module={exports:{}};modules.set(filename,module);
  const source=fs.readFileSync(filename,'utf8');
  const compiled=filename.endsWith('.ts')?ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText:source;
  vm.runInNewContext(compiled,{exports:module.exports,module,require:name=>load(path.resolve(path.dirname(filename),name)),wx,
   Page:page=>{capturedPage=page;},console,Uint8Array,Uint16Array,Uint32Array,Int32Array,ArrayBuffer,DataView,Date,setTimeout,clearTimeout,Promise,Map,Set});
  return module.exports;
 }
 return {s,load,disk,calls,mode:value=>{mode=value;},diskBroken:value=>{broken=value;},environment:value=>{environment=value;},page:()=>capturedPage};
}
async function setup(){
 const m=mobile(),banks=m.load('services/bank'),intake=m.load('services/intake'),store=m.load('services/intake-store');
 const bankId=await banks.createBank('测试题库');m.s.allow(bankId,'测试题库');
 const saved=await intake.saveReply(bankId,'',JSON.stringify(modelReply));
 return {m,banks,intake,store,bankId,batchId:saved.batchId,upload:m.load('services/cloud-intake').uploadBatch,cloud:m.load('services/cloud').cloud};
}

test('Mini Program gzip envelope round-trips through the deployed server validator, with UTF-8 and size limits',()=>{
 const {prepareUpload,encodeUtf8}=mobile().load('core/upload'),prepared=prepareUpload(fixture);
 for(const text of ['', '中文🧪𠮷\r\n', '\ud800', '\udfff', '\ud800A'])assert.equal(Buffer.from(encodeUtf8(text)).toString('hex'),Buffer.from(text).toString('hex'));
 assert.equal(gunzipSync(Buffer.from(prepared.envelope.data,'base64')).toString('utf8'),fixture);
 assert.equal(prepared.envelope.uncompressed_size,Buffer.byteLength(fixture));
 assert.equal(decodeUpload(prepared.envelope,parseDelta,parseModelReply).delta.batch_id,JSON.parse(fixture).batch_id);
 assert.equal(JSON.stringify(prepared.envelope),JSON.stringify(prepareUpload(fixture).envelope));
 const qs=Array.from({length:101},()=>toQuestion(modelReply,'测试题库',randomUUID,new Date().toISOString()));
 assert.throws(()=>prepareUpload(deltaPackage(randomUUID(),'测试题库',randomUUID(),qs,new Date().toISOString())),/100/);
 assert.throws(()=>prepareUpload(' '.repeat(4194305)),/大小限制/);
 const q=toQuestion({...modelReply,stem:'中文🧪'.repeat(500)},'测试题库',randomUUID,new Date().toISOString());
 const encoded=prepareUpload(deltaPackage(randomUUID(),'测试题库',randomUUID(),[q],new Date().toISOString()));
 assert.ok(Buffer.from(encoded.envelope.data,'base64').length<encoded.envelope.uncompressed_size/2);
 assert.equal(decodeUpload(encoded.envelope,parseDelta,parseModelReply).delta.question_count,1);
});
test('ordinary use is offline; login verifies server grants, never persists a token, and production has no test URL fallback',async()=>{
 const {m,cloud,bankId}=await setup();assert.equal(m.calls.length,0);assert.equal(cloud.state().loggedIn,false);
 await cloud.login();assert.equal(cloud.state().banks[0].bank_id,bankId);assert.equal(cloud.state().loggedIn,true);
 assert.equal(Object.keys(cloud.state()).sort().join(','),'banks,configured,loggedIn,openid,uploadsEnabled');
 for(const value of m.disk.values())assert.doesNotMatch(value,/access_token|v1\.[A-Za-z0-9_-]+\./);
 cloud.logout();assert.equal(cloud.state().loggedIn,false);m.environment('release');
 assert.equal(cloud.state().configured,false);await assert.rejects(cloud.login(),/尚未配置/);
});
test('server refusal or disabled upload preserves editable local drafts and does not create submissions',async()=>{
 const {m,store,upload,bankId,batchId}=await setup();m.s.env.QBANK_DEVELOPERS='{}';
 await assert.rejects(upload(bankId,batchId),/上传授权/);assert.equal(m.s.records.size,0);
 assert.equal((await store.readLocal()).batches[0].upload,undefined);
 m.s.allow(bankId,'测试题库');m.s.env.QBANK_UPLOAD_ENABLED='false';
 await assert.rejects(upload(bankId,batchId),/暂未开放/);assert.equal((await store.readLocal()).batches[0].upload,undefined);
 const other=await m.load('services/bank').createBank('另一个库');const local=await m.load('services/intake').saveReply(other,'',JSON.stringify(modelReply));
 m.s.env.QBANK_UPLOAD_ENABLED='true';await assert.rejects(upload(other,local.batchId),/没有当前题库/);
 assert.equal(m.s.records.size,0);
});
test('saved server receipt marks only the submitted batch, survives reopening, and later intake starts a new batch',async()=>{
 const {m,intake,store,upload,bankId,batchId}=await setup();
 const result=await upload(bankId,batchId);assert.equal(result.duplicate,false);assert.equal(m.s.records.size,1);
 let local=await store.readLocal();assert.equal(local.entries[0].uploadStatus,'uploaded');assert.equal(local.batches[0].upload.receipt.submission_id,result.receipt.submission_id);
 await assert.rejects(intake.markUpload(bankId,local.entries[0].question.question_id,false),/不能手动更改/);
 const next=await intake.saveReply(bankId,batchId,JSON.stringify({...modelReply,stem:'后续的新题'}));assert.notEqual(next.batchId,batchId);
 local=await store.readLocal();assert.equal(local.entries[1].uploadStatus,'pending');
 const reopened=mobile(m.s,m.disk);assert.equal((await reopened.load('services/intake-store').readLocal()).batches[0].upload.receipt.submission_id,result.receipt.submission_id);
 const file=await intake.exportBatch(batchId);assert.equal(m.disk.get(file.filePath),local.batches[0].upload.text);
});
test('lost response freezes exact bytes before POST and retry after restart recovers the original COS receipt',async()=>{
 const {m,intake,store,upload,bankId,batchId}=await setup();m.mode('lose-response');
 await assert.rejects(upload(bankId,batchId),/网络请求未完成/);assert.equal(m.s.records.size,1);
 const local=await store.readLocal(),text=local.batches[0].upload.text;
 assert.equal(local.entries[0].uploadStatus,'pending');assert.equal(local.batches[0].upload.receipt,undefined);
 const added=await intake.saveReply(bankId,batchId,JSON.stringify({...modelReply,stem:'丢失响应后的另一题'}));assert.notEqual(added.batchId,batchId);
 const reopened=mobile(m.s,m.disk),result=await reopened.load('services/cloud-intake').uploadBatch(bankId,batchId);
 assert.equal(result.duplicate,true);assert.equal(m.s.records.size,1);
 assert.equal((await reopened.load('services/intake-store').readLocal()).batches[0].upload.text,text);
 assert.equal((await reopened.load('services/intake-store').readLocal()).entries[1].uploadStatus,'pending');
});
test('export seals stable bytes before sharing; importing the whole package preserves its upload identity',async()=>{
 const {m,intake,store,upload,bankId,batchId}=await setup();
 const exported=await intake.exportBatch(batchId),original=m.disk.get(exported.filePath);
 assert.equal((await store.readLocal()).batches[0].sealedText,original);
 const next=await intake.saveReply(bankId,batchId,JSON.stringify({...modelReply,stem:'导出后的新题'}));assert.notEqual(next.batchId,batchId);
 assert.equal(m.disk.get((await intake.exportBatch(batchId)).filePath),original);
 const recipient=mobile(m.s),imported=await recipient.load('services/intake').importDelta(original);assert.equal(imported.added,1);
 assert.equal((await recipient.load('services/intake-store').readLocal()).batches[0].sealedText,original);
 assert.equal((await recipient.load('services/cloud-intake').uploadBatch(bankId,batchId)).duplicate,false);
 assert.equal((await upload(bankId,batchId)).duplicate,true);assert.equal(m.s.records.size,1);
});
test('partial imports get a new batch identity, while local entry continues past 100 without uploading',async()=>{
 const {m,intake,store,bankId,batchId}=await setup();
 const first=(await store.readLocal()).entries[0].question,second=toQuestion({...modelReply,stem:'包里新增的题'},'测试题库',randomUUID,new Date().toISOString()),senderBatch=randomUUID();
 const incoming=deltaPackage(bankId,'测试题库',senderBatch,[first,second],new Date().toISOString());
 const result=await intake.importDelta(incoming);assert.equal(result.added,1);assert.equal(result.skipped,1);
 const local=await store.readLocal(),partial=local.batches[1];assert.notEqual(partial.id,senderBatch);assert.equal(parseDelta(partial.sealedText).questions.length,1);
 await store.updateLocal(data=>{for(let i=1;i<100;i++)data.entries.push({...data.entries[0],question:toQuestion({...modelReply,stem:`满批次题 ${i}`},'测试题库',randomUUID,new Date().toISOString())});});
 m.load('services/bank').invalidateBank(bankId);
 const next=await intake.saveReply(bankId,batchId,JSON.stringify({...modelReply,stem:'第 101 题'}));assert.equal(next.batchId,batchId);
 assert.equal((await store.readLocal()).entries.filter(e=>e.batchId===batchId).length,101);assert.equal(m.calls.length,0);
});
test('invalid receipt and failed local persistence never mark uploaded; same-batch retries recover',async()=>{
 const {m,store,upload,bankId,batchId}=await setup();m.mode('bad-receipt');
 await assert.rejects(upload(bankId,batchId),/回执与本批次不一致/);assert.equal((await store.readLocal()).entries[0].uploadStatus,'pending');
 m.mode('disk-full');await assert.rejects(upload(bankId,batchId),/本地回执保存失败/);
 assert.equal((await store.readLocal()).entries[0].uploadStatus,'pending');
 m.diskBroken(false);m.mode('ok');assert.equal((await upload(bankId,batchId)).duplicate,true);
 assert.equal((await store.readLocal()).entries[0].uploadStatus,'uploaded');assert.equal(m.s.records.size,1);
});
test('failed snapshot save stops before POST; removed authorization clears session and leaves local data',async()=>{
 const {m,cloud,store,upload,bankId,batchId}=await setup();m.diskBroken(true);
 await assert.rejects(upload(bankId,batchId));assert.equal(m.s.records.size,0);assert.equal(m.calls.includes('/v1/uploads'),false);
 m.diskBroken(false);m.s.env.QBANK_DEVELOPERS='{}';
 await assert.rejects(upload(bankId,batchId),/上传授权/);assert.equal(cloud.state().loggedIn,false);
 assert.equal((await store.readLocal()).entries[0].uploadStatus,'pending');
});
test('expired sessions reauthenticate only on an explicit action and logout cancels an in-flight login',async()=>{
 const m=mobile(),{createCloudClient}=m.load('services/cloud'),bank={bank_id:randomUUID(),name:'测试'},token='v1.test.signature';
 let now=0,logins=0,release;
 const client=createCloudClient({origin:()=> 'https://test.invalid',now:()=>now,login:async()=>{logins++;return 'test-code';},request:async(_origin,p)=>({status:200,body:p.endsWith('wechat')?{access_token:token,openid:'user',expires_in:900,banks:[bank]}:{openid:'user',permissions:['upload'],uploads_enabled:true,banks:[bank]}})});
 await client.login();now=890000;assert.equal(client.state().loggedIn,false);assert.equal(logins,1);
 await client.authorize(bank.bank_id,bank.name);assert.equal(logins,2);
 const cancelled=createCloudClient({origin:()=> 'https://test.invalid',login:()=>new Promise(r=>{release=r;}),request:async(_origin,p)=>({status:200,body:p.endsWith('wechat')?{access_token:token,openid:'user',expires_in:900,banks:[bank]}:{openid:'user',permissions:['upload'],uploads_enabled:true,banks:[bank]}})});
 const pending=cancelled.login();cancelled.logout();release('test-code');await assert.rejects(pending,/登录已取消/);assert.equal(cancelled.state().loggedIn,false);
});

test('compressed file import decodes Node gzip, validates CRC and rejects truncated, concatenated or oversized data',async()=>{
 const m=mobile(),{unpackUpload}=m.load('core/upload');
 const envelope={format:'qbank-upload-1',encoding:'gzip+base64',uncompressed_size:Buffer.byteLength(fixture),sha256:sha256(fixture),data:gzipSync(Buffer.from(fixture)).toString('base64')};
 assert.equal(unpackUpload(JSON.stringify(envelope)),fixture);
 assert.equal((await m.load('services/intake').importDelta(JSON.stringify(envelope))).added,1);
 for(const data of [gzipSync(Buffer.from(fixture)).subarray(0,-1),Buffer.concat([gzipSync(Buffer.from(fixture)),gzipSync(Buffer.from('extra'))]),gzipSync(Buffer.alloc(4*1024*1024+1,65))])assert.throws(()=>unpackUpload(JSON.stringify({...envelope,data:data.toString('base64')})));
 const corrupt=gzipSync(Buffer.from(fixture));corrupt[corrupt.length-8]^=1;assert.throws(()=>unpackUpload(JSON.stringify({...envelope,data:corrupt.toString('base64')})));
 const exported=await m.load('services/intake').exportBatch(JSON.parse(fixture).batch_id,true);assert.equal(unpackUpload(m.disk.get(exported.filePath)),fixture);
});

test('anonymous sync updates pending layers, skips unchanged versions, survives corruption, disk full and offline reopening',async()=>{
 const {m,banks,intake,bankId}=await setup(),sync=m.load('services/sync');m.s.env.QBANK_SYNC_ENABLED='true';
 const q=toQuestion({...modelReply,stem:'远端候选'},'测试题库',randomUUID,new Date().toISOString());
 const state={format:'qbank-state-1',bank_id:bankId,name:'测试题库',revision:1,release_version:1,formal:[],pending:[{id:'test',question:q,decision:'pending'}],resolved:[],batches:[],updated_at:new Date().toISOString()};m.s.states.set(bankId,state);
 await sync.refreshCatalog();assert.equal(await sync.syncBank(bankId),true);banks.invalidateBank(bankId);assert.equal((await banks.loadBank(bankId)).bank.count,2);assert.ok(!m.calls.includes('wx.login'));
 const downloads=()=>m.calls.filter(p=>p.endsWith('/snapshot')).length;const oldCount=downloads();assert.equal(await sync.syncBank(bankId),false);assert.equal(downloads(),oldCount);
 state.revision=2;state.pending=[];state.resolved=[{id:'test',question_id:q.question_id,status:'rejected'}];
 m.mode('corrupt');await assert.rejects(sync.syncBank(bankId));assert.equal((await sync.cachedSnapshot(bankId)).manifest.revision,1);
 m.mode('ok');m.diskBroken(true);await assert.rejects(sync.syncBank(bankId));assert.equal((await sync.cachedSnapshot(bankId)).manifest.revision,1);
 m.diskBroken(false);assert.equal(await sync.syncBank(bankId),true);banks.invalidateBank(bankId);assert.equal((await banks.loadBank(bankId)).bank.count,1);
 const reopened=mobile(m.s,m.disk);reopened.mode('offline');await assert.rejects(reopened.load('services/sync').syncBank(bankId));assert.equal((await reopened.load('services/bank').loadBank(bankId)).bank.count,1);
 const other=await banks.createBank('高级认证');await intake.saveReply(other,'',JSON.stringify({...modelReply,stem:'另一题库独立题'}));assert.equal((await banks.loadBank(other)).bank.count,1);assert.equal((await banks.loadBank(bankId)).bank.count,1);
});

test('final confirmation splits 205 local questions atomically, survives lost receipts, and never submits later drafts',async()=>{
 const {m,store,bankId,batchId,intake}=await setup(),queue=m.load('services/cloud-intake');
 await store.updateLocal(d=>{for(let n=1;n<205;n++)d.entries.push({...d.entries[0],question:toQuestion({...modelReply,stem:`整批题 ${n}`},'测试题库',randomUUID,new Date().toISOString())});});
 assert.equal(m.calls.length,0);await queue.enqueueBatches(bankId,[batchId]);let local=await store.readLocal();
 assert.equal(local.jobs.length,3);assert.deepEqual(Array.from(local.jobs,j=>parseDelta(local.batches.find(b=>b.id===j.id).upload.text).questions.length),[100,100,5]);
 assert.equal(m.s.records.size,0);const frozen=local.jobs.map(j=>local.batches.find(b=>b.id===j.id).upload.text);
 m.load('services/bank').invalidateBank(bankId);await intake.saveReply(bankId,'',JSON.stringify({...modelReply,stem:'确认后才录的新题'}));
 m.mode('lose-response');await queue.runUploadQueue();local=await store.readLocal();assert.equal(local.jobs.filter(j=>j.status==='done').length,2);assert.equal(m.s.records.size,3);
 const reopened=mobile(m.s,m.disk),again=reopened.load('services/cloud-intake'),cloud=reopened.load('services/cloud').cloud;
 await cloud.login();await again.retryUploads();await again.runUploadQueue();local=await reopened.load('services/intake-store').readLocal();
 assert.ok(local.jobs.every(j=>j.status==='done'));assert.equal(m.s.records.size,3);assert.equal(local.entries.filter(e=>e.uploadStatus==='pending').length,1);
 for(let n=0;n<3;n++)assert.equal(local.batches.find(b=>b.id===local.jobs[n].id).upload.text,frozen[n]);
 for(const record of m.s.records.values())assert.equal(record.status,'pending_merge');
});
test('logout and revoked grants pause confirmed jobs; unconfirmed drafts survive page recreation and failed bank switches',async()=>{
 const {m,store,bankId,batchId,cloud}=await setup(),queue=m.load('services/cloud-intake');
 await queue.enqueueBatches(bankId,[batchId]);cloud.logout();await queue.pauseUploads();const before=m.calls.length;await queue.runUploadQueue();assert.equal(m.calls.length,before);
 await cloud.login();await queue.retryUploads();m.s.env.QBANK_DEVELOPERS='{}';await queue.runUploadQueue();assert.equal((await store.readLocal()).jobs[0].status,'paused');assert.equal(m.s.records.size,0);
 m.load('pages/intake/intake');const page=m.page();page.setData=function(v){Object.assign(this.data,v)};page.data.bankId=bankId;page.data.reply={...modelReply,answer:[]};await page.persistDraft();
 const reopened=mobile(m.s,m.disk);reopened.load('pages/intake/intake');const next=reopened.page();next.setData=function(v){Object.assign(this.data,v)};next.data.bankId=bankId;await next.restoreDraft();assert.deepEqual(Array.from(next.data.reply.answer),[]);assert.equal(next.data.reply.stem,modelReply.stem);
 const other=await m.load('services/bank').createBank('另一个库');page.data.banks=[{id:bankId,name:'测试题库'},{id:other,name:'另一个库'}];m.diskBroken(true);
 page.onBankChange({detail:{value:'1'}});for(let n=0;n<20&&page.locked;n++)await new Promise(r=>setTimeout(r,0));assert.equal(page.data.bankId,bankId);assert.match(page.data.error,/草稿/);
});
test('editing a saved mini question preserves its first recording time and metadata',async()=>{
 const {intake,store,bankId}=await setup();const first=(await store.readLocal()).entries[0];
 await intake.editReply(bankId,first.question.question_id,JSON.stringify({...modelReply,stem:'修正的完整题干',answer:['B']}),{chapter:'新章节',tags:['标签'],difficulty:'hard'});
 const changed=(await store.readLocal()).entries[0].question;assert.equal(changed.recorded_at,first.question.recorded_at);assert.equal(changed.recorded_at_source,'local');assert.equal(changed.base_revision,2);assert.equal(changed.chapter,'新章节');assert.deepEqual(Array.from(changed.answer),['B']);
});

test('editing a local question cannot duplicate a question already in the formal bank',async()=>{
 const {m,intake,store,bankId}=await setup(),banks=m.load('services/bank');
 const first=(await store.readLocal()).entries[0],original=first.question.stem;
 const formal=toQuestion({...modelReply,stem:'正式题库已有题'},'测试题库',randomUUID,new Date().toISOString());
 const load=banks.loadBank;banks.loadBank=async()=>({bank:{count:2,question:i=>i?formal:first.question}});
 await assert.rejects(intake.editReply(bankId,first.question.question_id,JSON.stringify({...modelReply,stem:formal.stem})),/已有题目/);
 assert.equal((await store.readLocal()).entries[0].question.stem,original);banks.loadBank=load;
});

test('intake page combines all unuploaded records into one list while isolating other banks and receipts',async()=>{
 const {m,intake,store,bankId,batchId}=await setup();
 await intake.exportBatch(batchId);
 const second=await intake.saveReply(bankId,batchId,JSON.stringify({...modelReply,stem:'同一题库下一次录入'}));
 assert.notEqual(second.batchId,batchId);
 const other=await m.load('services/bank').createBank('另一个题库');
 await intake.saveReply(other,'',JSON.stringify({...modelReply,stem:'不混入当前列表'}));
 m.load('pages/intake/intake');const page=m.page();page.setData=function(v){Object.assign(this.data,v)};page.data.bankId=bankId;
 await page.refresh();assert.equal(page.data.entries.length,2);assert.ok(page.data.entries.every(e=>e.statusLabel.startsWith('待上传')));assert.equal(m.s.records.size,0);
 await store.updateLocal(d=>{d.entries.find(e=>e.batchId===batchId).uploadStatus='uploaded'});
 await page.refresh();assert.equal(page.data.entries.length,1);assert.equal(page.data.entries[0].stem,'同一题库下一次录入');
});
