import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {fileURLToPath} from 'node:url';
import {parseModelReply,toQuestion,identityKey,sameAnswer,deltaPackage,parseDelta,sha256,uuidFromBytes,intakeMetadata} from '../desktop/shared/intake.ts';
const reply={format:'qbank-photo-question-1',type:'single',stem:'此 API 返回什么？',options:[{key:'A',content:'中文 🧪'},{key:'B',content:'字符串 "A"'}],answer:['B'],answer_origin:'inferred',explanation:'测试作答依据。',model:{name:'测试模型',version:'test-1',version_source:'user'},warnings:[]};
const id=()=>uuidFromBytes(randomBytes(16));
test('copyable single JSON reply validates independently and rejects incomplete answers/photos',()=>{
 assert.deepEqual(parseModelReply('```json\n'+JSON.stringify(reply)+'\n```'),reply);
 for(const value of [{...reply,answer:null},{...reply,answer:['C']},{...reply,type:'true_false',answer:'false',options:[]},{...reply,model:{name:'x'}},{...reply,photo:'https://example.com/secret.png'},{...reply,stem:'【看不清】'}])assert.throws(()=>parseModelReply(JSON.stringify(value)));
 assert.throws(()=>parseModelReply(JSON.stringify([reply,reply])));
 assert.throws(()=>parseModelReply('前言\n```json\n'+JSON.stringify(reply)+'\n```'));
});
test('reordered options remap answers without conflating code case or changing question text',()=>{
 const reordered={...reply,options:[{key:'A',content:reply.options[1].content},{key:'B',content:reply.options[0].content}],answer:['A']};
 assert.equal(identityKey(reply),identityKey(reordered));assert.ok(sameAnswer(reply,reordered));
 assert.ok(!sameAnswer(reply,{...reordered,answer:['B']}));
 assert.notEqual(identityKey(reply),identityKey({...reply,stem:reply.stem.toLowerCase()}));
});
test('UTF-8 SHA-256 matches Node including emoji, CRLF, lone surrogate and padding boundaries',()=>{
 for(const value of ['', 'abc','照片题干\r\n🧪','\ud800',...Array.from({length:140},(_,i)=>'a'.repeat(i))])assert.equal(sha256(value),createHash('sha256').update(value).digest('hex'));
});
test('mobile delta keeps full model provenance, checks corruption and omits upload state',()=>{
 const q=toQuestion(parseModelReply(JSON.stringify(reply)),'高级认证',id,'2026-10-15T00:00:00Z');
 const text=deltaPackage(id(),'高级认证',id(),[q],'2026-10-15T00:00:00Z');
 assert.deepEqual(parseDelta(text).questions,[q]);assert.ok(!text.includes('uploaded_manual'));
 const changed=JSON.parse(text);changed.payload=changed.payload.replace('API','Api');assert.throws(()=>parseDelta(JSON.stringify(changed)),/校验/);
});

const root=fileURLToPath(new URL('../miniprogram/miniprogram/',import.meta.url));
function mobile(disk=new Map()){
 const modules=new Map(),storage=new Map();let broken=false;
 const wx={env:{USER_DATA_PATH:'/local'},getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),
  getRandomValues:o=>{const b=randomBytes(o.length);o.success({randomValues:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)})},
  getFileSystemManager:()=>({readFile:o=>disk.has(o.filePath)?o.success({data:disk.get(o.filePath)}):o.fail({errMsg:'ENOENT no such file'}),
   writeFile:o=>broken?o.fail({errMsg:'disk full'}):(disk.set(o.filePath,o.data),o.success()),
   rename:o=>{disk.set(o.newPath,disk.get(o.oldPath));disk.delete(o.oldPath);o.success()}})};
 function load(relative){
  const absolute=path.resolve(root,relative);const filename=fs.existsSync(absolute+'.js')?absolute+'.js':relative.endsWith('.ts')?absolute:absolute+'.ts';
  if(modules.has(filename))return modules.get(filename);
  const exports={},module={exports};modules.set(filename,exports);
  const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(source,{exports,module,require:name=>load(path.resolve(path.dirname(filename),name)),wx,console,Uint8Array,Uint16Array,Uint32Array,Int32Array,ArrayBuffer,DataView,setTimeout,clearTimeout,Date,Promise,Map,Set});return module.exports;
 }
 return {load,disk,breakDisk:()=>{broken=true}};
}
test('mobile local intake persists batches, isolates banks, imports idempotently and keeps failed writes out of search',async()=>{
 const env=mobile(),banks=env.load('services/bank'),intake=env.load('services/intake'),store=env.load('services/intake-store');
 const a=await banks.createBank('初级测试'),b=await banks.createBank('高级测试');
 const first=await intake.saveReply(a,'',JSON.stringify(reply));assert.ok(first.added);
 assert.equal((await banks.loadBank(a)).bank.count,1);assert.equal((await banks.loadBank(b)).bank.count,0);
 assert.equal((await intake.saveReply(a,first.batchId,JSON.stringify(reply))).added,false);
 await intake.markUpload(a,(await store.readLocal()).entries[0].question.question_id,true);
 const file=await intake.exportBatch(first.batchId),packet=env.disk.get(file.filePath);assert.equal(parseDelta(packet).questions.length,1);
 assert.equal((await store.readLocal()).entries[0].uploadStatus,'uploaded_manual');
 const fresh=mobile(),other=fresh.load('services/intake'),otherBanks=fresh.load('services/bank');
 assert.equal((await other.importDelta(packet)).added,1);assert.equal((await other.importDelta(packet)).skipped,1);
 assert.equal((await otherBanks.loadBank(a)).bank.count,1);
 assert.equal((await fresh.load('services/intake-store').readLocal()).entries[0].uploadStatus,'pending');
 const reopened=mobile(env.disk);assert.equal((await reopened.load('services/bank').loadBank(a)).bank.count,1);
 env.breakDisk();await assert.rejects(intake.saveReply(a,first.batchId,JSON.stringify({...reply,stem:'第二道新题'})));
 assert.equal((await banks.loadBank(a)).bank.count,1);assert.equal((await store.readLocal()).entries.length,1);
});
test('cross-platform fixture is the shared mobile export format',()=>{
 const fixture=fs.readFileSync(new URL('fixtures/intake/mobile-delta.json',import.meta.url),'utf8');
 assert.equal(parseDelta(fixture).questions[0].sources[0].model.version,'test-1');
});

test('manual metadata survives mobile persistence and compressed exchange without changing model attribution',async()=>{
 const env=mobile(),banks=env.load('services/bank'),service=env.load('services/intake');
 const bank=await banks.createBank('补充字段');
 const metadata=intakeMetadata({chapter:'组件',tags:['UI',' UI ','ArkTS'],difficulty:'hard',applicable_version:'API 12',external_id:'X-1'});
 assert.deepEqual(metadata.tags,['UI','ArkTS']);
 const result=await service.saveReply(bank,'',JSON.stringify(reply),metadata);
 const out=await service.exportBatch(result.batchId,true);
 const decoded=env.load('core/upload').unpackUpload(env.disk.get(out.filePath));
 const q=parseDelta(decoded).questions[0];for(const key of Object.keys(metadata))assert.deepEqual(q[key],metadata[key]);
 assert.equal(q.sources[0].model.version,reply.model.version);
 assert.throws(()=>intakeMetadata({difficulty:'invalid'}));
 await assert.rejects(service.saveReply(bank,'',JSON.stringify({...reply,stem:'坏元数据'}),{tags:['x'.repeat(101)]}));
 assert.equal((await banks.loadBank(bank)).bank.count,1);
});

test('partial replies are editable while submission remains strict; answer dots distinguish unset from false',async()=>{
 const {parseDraft,toggleAnswer,emptyReply,recordedTime,resultName,withRecordedTime}=await import('../desktop/shared/intake.ts');
 const partial=parseDraft(JSON.stringify({stem:'未完成判断',type:'true_false'}));assert.equal(partial.stem,'未完成判断');assert.deepEqual(partial.answer,[]);assert.throws(()=>parseModelReply(JSON.stringify(partial)));
 assert.deepEqual(parseDraft(JSON.stringify({...reply,options:[{key:'B',content:'二'},{key:'A',content:'一'}],answer:['A']})).answer,['B']);
 const yes=toggleAnswer(partial,false);assert.equal(yes.answer,false);assert.deepEqual(toggleAnswer(yes,false).answer,[]);
 assert.deepEqual(toggleAnswer(reply,'B').answer,[]);assert.deepEqual(toggleAnswer({...reply,type:'multiple',answer:['A']},'B').answer,['A','B']);
 assert.equal(recordedTime({...toQuestion(reply,'时间测试',id,'2026-10-18T01:02:03.456Z')}),'2026-10-18T01:02:03.456Z');assert.equal(recordedTime({sources:[]}),null);
 const unknown={...toQuestion(reply,'时间测试',id,'2026-10-18T01:02:03.456Z'),recorded_at:null,recorded_at_source:'unknown',sources:[]};
 assert.equal(withRecordedTime(unknown,'2026-10-18T02:00:00Z').recorded_at,null);
 assert.equal(withRecordedTime({...unknown,recorded_at_source:undefined},'2026-10-18T02:00:00Z').recorded_at_source,'import');
 const name=resultName('2026-10-18T01:02:03.456Z','坏/名称:*','合并','v2','12345678-x','abcdef1234');assert.match(name,/20261018-090203456\+0800/);assert.doesNotMatch(name,/[\/:*?]/);assert.deepEqual(emptyReply().answer,[]);
});
