import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as syncCore from '../desktop/shared/sync.ts';
import {packText} from '../desktop/shared/codec.ts';
import {sha256} from '../desktop/shared/intake.ts';

const first='ad50971f-66af-51c2-bb0e-dc798b03b369',second='c86104f7-4570-4089-9338-7989ce528a9d';
function version(bank_id,name,revision=1){
 const text=JSON.stringify({format:'qbank-snapshot-2',bank_id,name,revision,release_version:revision,formal:[],pending:[],removed:[],updated_at:'2026-10-24T00:00:00Z'}),wrapper=packText(text);
 return {wrapper,manifest:{bank_id,name,revision,release_version:revision,question_count:0,sha256:wrapper.sha256,bytes:Buffer.byteLength(text),minimum_client:'0.2.7',protocol:2,snapshot_format:'qbank-cloud-file-1',updated_at:'2026-10-24T00:00:00Z'}};
}
function setup({replaceRename=false,snapshotGate=null}={}){
 let generation=1,failBank='',restore,offline=false,requestError='';
 const files=new Map(),calls=[],versions=[version(first,'初级'),version(second,'高级')];
 const fileSystem={
  readFile:o=>{if(o.filePath.endsWith('qbank-cloud-catalog.json')&&restore){restore(o);return;}files.has(o.filePath)?o.success({data:files.get(o.filePath)}):o.fail({errMsg:'not found'});},
  readdir:o=>o.success({files:[...files.keys()].filter(path=>path.startsWith(`${o.dirPath}/`)).map(path=>path.slice(o.dirPath.length+1))}),
  writeFile:o=>{files.set(o.filePath,o.data);o.success();},
  copyFile:o=>{if(!files.has(o.srcPath))return o.fail({errMsg:'not found'});files.set(o.destPath,files.get(o.srcPath));o.success();},
  unlink:o=>{if(!files.delete(o.filePath))return o.fail({errMsg:'not found'});o.success();},
  rename:o=>{if(replaceRename&&files.has(o.newPath))return o.fail({errMsg:'file already exists'});files.set(o.newPath,files.get(o.oldPath));files.delete(o.oldPath);o.success();},
 };
 const wx={env:{USER_DATA_PATH:'/user'},getFileSystemManager:()=>fileSystem,request:o=>{
  const endpoint=new URL(o.url).pathname;calls.push(endpoint);
  if(requestError)return o.fail({errMsg:requestError});
  if(offline)return o.fail({errMsg:'offline'});
  if(endpoint==='/v1/catalog')return o.success({statusCode:200,data:{banks:versions.map(v=>v.manifest)}});
  const v=versions.find(v=>endpoint.includes(v.manifest.bank_id));
  if(v?.manifest.bank_id===failBank)return o.fail({errMsg:'offline'});
  const finish=()=>o.success({statusCode:v?200:404,data:endpoint.endsWith('/manifest')?v.manifest:v.wrapper});
  if(v&&endpoint.endsWith('/snapshot-file')&&snapshotGate){snapshotGate.started();snapshotGate.promise.then(finish);}
  else finish();
 }};
 const exports={},source=fs.readFileSync(new URL('../miniprogram/miniprogram/services/sync.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports,require:name=>name.endsWith('/config/cloud')?{authOrigin:()=> 'https://qbank.example.test:8013'}:name.endsWith('/foreground')?{foregroundGeneration:()=>generation}:name.endsWith('/core/sync')?syncCore:name.endsWith('/core/search')?{buildPostings:()=>({})}:{sha256},wx,Map,Promise,Error});
 return {client:exports,calls,versions,files,next:()=>generation++,fail:id=>failBank=id,setOffline:value=>offline=value,setRequestError:value=>requestError=value,delayRestore:fn=>restore=o=>{restore=undefined;fn(o)}};
}
test('multi-bank catalogue refresh is once per foreground, downloads are per-bank and unchanged revisions stay cached',async()=>{
 const s=setup(),c=s.client;
 await Promise.all([c.refreshCatalog(),c.refreshCatalog()]);await c.refreshCatalog();
 assert.equal(s.calls.filter(p=>p==='/v1/catalog').length,1);assert.equal(c.cloudCatalog().length,2);
 for(const m of c.cloudCatalog())assert.equal(await c.syncBank(m.bank_id,m),true);
 assert.equal(await c.syncBank(first,c.cloudCatalog()[0]),false);
 assert.equal(s.calls.length,3);assert.equal((await c.cachedSnapshot(second)).manifest.name,'高级');
 s.next();await c.refreshCatalog();assert.equal(s.calls.length,4);
 await c.refreshCatalog(true);assert.equal(s.calls.length,5);
 s.versions[1]=version(second,'高级',2);s.next();await c.refreshCatalog();
 assert.equal(await c.syncBank(second,c.cloudCatalog()[1]),true);assert.equal((await c.cachedSnapshot(first)).manifest.revision,1);assert.equal((await c.cachedSnapshot(second)).manifest.revision,2);
});
test('one failed bank keeps the complete catalogue and the other bank remains independently readable',async()=>{
 const s=setup(),c=s.client;await c.refreshCatalog();s.fail(first);
 await assert.rejects(c.syncBank(first,c.cloudCatalog()[0]),/网络/);
 assert.equal(c.cloudCatalog().length,2);assert.equal(await c.syncBank(second,c.cloudCatalog()[1]),true);
 assert.equal((await c.cachedSnapshot(second)).snapshot.bank_id,second);
});
test('offline catalogue checks and interrupted updates retain each bank cache and its original version',async()=>{
 const s=setup(),c=s.client;await c.refreshCatalog();
 for(const m of c.cloudCatalog())await c.syncBank(m.bank_id,m);
 const files=JSON.stringify([...s.files]);s.setOffline(true);s.next();
 await assert.rejects(c.refreshCatalog(),/网络/);
 assert.equal(c.cloudCatalog().length,2);
 assert.equal((await c.cachedSnapshot(first)).manifest.revision,1);
 assert.equal((await c.cachedSnapshot(second)).manifest.revision,1);
 await assert.rejects(c.syncBank(second,version(second,'高级',2).manifest),/网络/);
 assert.equal(JSON.stringify([...s.files]),files);
 assert.equal((await c.cachedSnapshot(second)).snapshot.revision,1);
});
test('slow disk restore cannot replace a newer two-bank catalogue with stale data',async()=>{
 const s=setup();let release;
 s.delayRestore(o=>{release=()=>{const payload=JSON.stringify([s.versions[0].manifest]);o.success({data:JSON.stringify({payload,sha256:sha256(payload)})})};});
 const restore=s.client.restoreCatalog(),fresh=s.client.refreshCatalog();release();await Promise.all([restore,fresh]);
 assert.equal(s.client.cloudCatalog().length,2);assert.equal(s.calls.filter(p=>p==='/v1/catalog').length,1);
});

test('domain, TLS and timeout errors remain specific while preserving both bank caches',async()=>{
 const s=setup(),c=s.client;
 s.setRequestError('request:fail url not in domain list');
 await assert.rejects(c.refreshCatalog(),/request 合法域名/);
 assert.equal(c.cloudCatalog().length,0);assert.equal(s.files.size,0);
 s.setRequestError('');await c.refreshCatalog();
 for(const m of c.cloudCatalog())await c.syncBank(m.bank_id,m);
 const stored=JSON.stringify([...s.files]);
 for(const [error,message] of [['request:fail url not in domain list',/request 合法域名/],['request:fail ERR_CONNECTION_RESET',/HTTPS 连接失败/],['request:fail ssl hand shake error',/HTTPS 连接失败/],['request:fail timeout',/请求超时/]]){
  s.setRequestError(error);await assert.rejects(c.refreshCatalog(true),message);
  assert.equal(c.cloudCatalog().length,2);assert.equal((await c.cachedSnapshot(second)).manifest.name,'高级');assert.equal(JSON.stringify([...s.files]),stored);
 }
 s.setRequestError('');await c.refreshCatalog(true);assert.equal(c.cloudCatalog().length,2);
});

test('manifest question counts reject mismatched snapshots and keep the previous bank',async()=>{
 const s=setup(),c=s.client;await c.refreshCatalog();await c.syncBank(first,c.cloudCatalog()[0]);
 const next=version(first,'初级',2);s.versions[0]={...next,manifest:{...next.manifest,question_count:1}};s.next();await c.refreshCatalog();
 await assert.rejects(c.syncBank(first,c.cloudCatalog()[0]),/数量与版本清单不一致/);
 assert.equal((await c.cachedSnapshot(first)).manifest.revision,1);
 assert.equal((await c.cachedSnapshot(first)).snapshot.formal.length,0);
});

test('cache replacement survives file systems that refuse to overwrite by rename',async()=>{
 const s=setup({replaceRename:true}),c=s.client;await c.refreshCatalog();await c.syncBank(first,c.cloudCatalog()[0]);
 s.versions[0]=version(first,'初级',2);s.next();await c.refreshCatalog();
 assert.equal(await c.syncBank(first,c.cloudCatalog()[0]),true);
 assert.equal((await c.cachedSnapshot(first)).manifest.revision,2);
 assert.equal(s.files.has(`/user/qbank-cloud-${first}.json.bak`),false);
});

test('a damaged or missing catalogue can still be restored from per-bank cache files',async()=>{
 const source=setup(),firstClient=source.client;await firstClient.refreshCatalog();await firstClient.syncBank(first,source.versions[0].manifest);
 const cache=source.files.get(`/user/qbank-cloud-${first}.json`);
 const target=setup(),client=target.client;target.files.set(`/user/qbank-cloud-${first}.json.bak`,cache);
 await client.restoreCatalog();
 assert.equal(client.cloudCatalog().length,1);
 assert.equal(client.cloudCatalog()[0].bank_id,first);
 assert.equal((await client.cachedSnapshot(first)).manifest.revision,1);
});

test('a newer per-bank cache wins over an older catalogue left by an interrupted refresh',async()=>{
 const source=setup(),sourceClient=source.client;await sourceClient.refreshCatalog();await sourceClient.syncBank(first,source.versions[0].manifest);
 source.versions[0]=version(first,'初级',2);await sourceClient.syncBank(first,source.versions[0].manifest);
 const target=setup(),client=target.client;
 for(const key of ['qbank-cloud-catalog.json',`qbank-cloud-${first}.json`])target.files.set(`/user/${key}`,source.files.get(`/user/${key}`));
 await client.restoreCatalog();
 assert.equal(client.cloudCatalog()[0].revision,2);
 assert.equal((await client.cachedSnapshot(first)).manifest.revision,2);
});

test('an explicit reload redownloads and replaces the cache even when the manifest did not change',async()=>{
 const s=setup(),c=s.client;await c.refreshCatalog();await c.syncBank(first,s.versions[0].manifest);
 const before=s.calls.filter(path=>path.endsWith('/snapshot-file')).length;
 assert.equal(await c.reloadBank(first,s.versions[0].manifest),true);
 assert.equal(s.calls.filter(path=>path.endsWith('/snapshot-file')).length,before+1);
 assert.equal((await c.cachedSnapshot(first)).manifest.revision,1);
});

test('an explicit reload waits for an older in-flight sync before downloading the new cache',async()=>{
 let release,started;
 const entered=new Promise(resolve=>{started=resolve;});
 const snapshotGate={started, promise:new Promise(resolve=>{release=resolve;})};
 const s=setup({snapshotGate}),c=s.client;await c.refreshCatalog();
 const normal=c.syncBank(first,s.versions[0].manifest);
 await entered;
 const forced=c.reloadBank(first,s.versions[0].manifest);
 release();
 assert.equal(await normal,true);
 assert.equal(await forced,true);
 assert.equal(s.calls.filter(path=>path.endsWith('/snapshot-file')).length,2);
});
