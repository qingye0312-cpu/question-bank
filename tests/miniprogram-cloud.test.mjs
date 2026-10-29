import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {gzipSync} from 'node:zlib';
import {parseDelta,sha256} from '../desktop/shared/intake.ts';

const root=new URL('../miniprogram/miniprogram/',import.meta.url);
const fixture=fs.readFileSync(new URL('fixtures/intake/mobile-delta.json',import.meta.url),'utf8');

function load(relative,globals={}){
  const cache=new Map();
  function read(name){
    let url=new URL(name,root);
    if(!url.pathname.endsWith('.ts')&&!url.pathname.endsWith('.js')){
      const tsUrl=new URL(`${name}.ts`,root),jsUrl=new URL(`${name}.js`,root);
      url=fs.existsSync(tsUrl)?tsUrl:jsUrl;
    }
    if(cache.has(url.href))return cache.get(url.href);
    const source=fs.readFileSync(url,'utf8'),exports={};cache.set(url.href,exports);
    const compiled=url.pathname.endsWith('.ts')?ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText:source;
    vm.runInNewContext(compiled,{exports,module:{exports},require:child=>read(new URL(child,url).pathname.replace(root.pathname,'')),console,Uint8Array,Uint16Array,Uint32Array,Int32Array,ArrayBuffer,DataView,Date,Map,Set,Error,Promise,TextDecoder,setTimeout,clearTimeout,...globals});
    return exports;
  }
  return read(relative);
}

const {prepareUpload,unpackUpload,verifyReceipt}=load('core/upload.ts');
test('Mini Program TypeScript services keep extensionless local imports for WeChat module resolution',()=>{
 const source=fs.readFileSync(new URL('services/maintainer-application.ts',root),'utf8');
 assert.doesNotMatch(source,/from\s+['"]\.\/maintainer-password-policy\.ts['"]/);
});
const authStorage=new Map();
const {createCloudClient}=load('services/cloud.ts',{wx:{setStorageSync:(key,value)=>authStorage.set(key,value),getStorageSync:key=>authStorage.get(key),removeStorageSync:key=>authStorage.delete(key)}});
const bankId=JSON.parse(fixture).bank_id;

test('Mini Program upload format is one gzip plus Base64 envelope and round-trips exactly',()=>{
  const prepared=prepareUpload(fixture);
  assert.equal(prepared.envelope.format,'qbank-upload-1');
  assert.equal(prepared.envelope.encoding,'gzip+base64');
  assert.equal(unpackUpload(JSON.stringify(prepared.envelope)),fixture);
  assert.equal(parseDelta(unpackUpload(JSON.stringify(prepared.envelope))).delta.question_count,1);
  const compressed=gzipSync(Buffer.from(fixture));
  const malformed={...prepared.envelope,data:Buffer.concat([compressed,gzipSync(Buffer.from('extra'))]).toString('base64')};
  assert.throws(()=>unpackUpload(JSON.stringify(malformed)));
});

for(const envVersion of ['develop','trial','release'])test(`Mini Program ${envVersion} client uses phone/password login and uploads through its configured transport`,async()=>{
  const requests=[];
  const config=load('config/cloud.ts',{wx:{getAccountInfoSync:()=>({miniProgram:{appId:'wx22c8135ae81d3acc',envVersion}})}});
  const origin=config.authOrigin();
  assert.equal(origin,'https://qbank.acharrystar.top:8013');
  const bank={bank_id:bankId,name:'跨端测试题库'};
  const client=createCloudClient({origin:()=>origin,request:async(_origin,path,method,body,token)=>{
    assert.equal(_origin,origin);
    requests.push({path,method,body,token});
    if(path==='/v1/auth/password-login')return {status:200,body:{access_token:'v1.token.signature',refresh_token:`r1.${'a'.repeat(43)}`,expires_in:900,openid:'p_account',phone:'+861****5678',status:'approved',banks:[bank]}};
    if(path==='/v1/me')return {status:200,body:{openid:'p_account',permissions:['upload'],uploads_enabled:true,banks:[bank]}};
    if(path==='/v1/uploads')return {status:201,body:{duplicate:false,receipt:{submission_id:sha256(`${bankId}/${JSON.parse(fixture).batch_id}`),bank_id:bankId,batch_id:JSON.parse(fixture).batch_id,sha256:body.package.sha256,payload_sha256:JSON.parse(fixture).sha256,question_count:1,status:'merged',accepted_at:'2026-10-24T00:00:00Z',merged_at:'2026-10-24T00:00:01Z',added_count:1,duplicate_count:0,revision:2,release_version:2,release_name:'20261024-080000+0800_跨端测试题库_合并_v2'}}};
    throw new Error(`unexpected ${method} ${path}`);
  }});
  const access=await client.loginPassword('+86 13812345678','StrongPass123');
  assert.equal(access.loggedIn,true);assert.equal(access.banks[0].bank_id,bankId);
  assert.equal(await client.authorize(bankId,bank.name),origin);
  const prepared=prepareUpload(fixture),result=await client.upload(prepared,origin);
  assert.equal(result.receipt.status,'merged');assert.equal(result.duplicate,false);
  assert.equal(requests[0].path,'/v1/auth/password-login');assert.equal(requests[0].body.phone,'13812345678');assert.equal(requests[0].body.password,'StrongPass123');assert.equal(requests[0].body.client,'miniprogram');
  assert.equal(requests.at(-1).body.format,'qbank-confirmed-upload-1');assert.equal(requests.at(-1).body.package.format,'qbank-upload-1');
  assert.equal(client.state().openid,'p_account');assert.ok(!JSON.stringify(client.state()).includes('v1.token.signature'));
});

test('Mini Program receipt verification accepts only merged or duplicate results',()=>{
  const expected=prepareUpload(fixture),base={submission_id:sha256(`${bankId}/${expected.delta.batch_id}`),bank_id:bankId,batch_id:expected.delta.batch_id,sha256:expected.envelope.sha256,payload_sha256:expected.delta.sha256,question_count:1,accepted_at:'2026-10-24T00:00:00Z',merged_at:'2026-10-24T00:00:01Z',added_count:1,duplicate_count:0,revision:2,release_version:2,release_name:'20261024-080001_测试库'};
  for(const status of ['merged','duplicate'])assert.equal(verifyReceipt({...base,status},expected).status,status);
  for(const status of ['review','queued'])assert.throws(()=>verifyReceipt({...base,status},expected));
  const complete=verifyReceipt({...base,status:'merged'},expected);assert.equal(complete.merged_at,base.merged_at);assert.equal(complete.revision,2);
  for(const field of ['merged_at','revision','release_version','release_name','added_count','duplicate_count']){const missing={...base,status:'merged'};delete missing[field];assert.throws(()=>verifyReceipt(missing,expected));}
  assert.throws(()=>verifyReceipt({...base,status:'merged',added_count:2},expected));
});

test('Mini Program login cannot be overwritten by a slower startup restore',async()=>{
 const origin='https://race.example.test',oldRefresh=`r1.${'b'.repeat(43)}`,newRefresh=`r1.${'c'.repeat(43)}`;
 const storageKey=`qbank-maintainer-refresh-v1:${origin}`;authStorage.set(storageKey,oldRefresh);
 let releaseRestore;const restoreGate=new Promise(resolve=>{releaseRestore=resolve;});
 const requests=[];
 const client=createCloudClient({origin:()=>origin,request:async(_origin,path,_method,body,token)=>{
   requests.push({path,body,token});
   if(path==='/v1/auth/refresh'){await restoreGate;return {status:200,body:{access_token:'v1.restore.signature',refresh_token:oldRefresh,expires_in:900,openid:'p_restore',status:'approved',banks:[]}};}
   if(path==='/v1/auth/password-login')return {status:200,body:{access_token:'v1.login.signature',refresh_token:newRefresh,expires_in:900,openid:'p_login',status:'approved',banks:[]}};
   if(path==='/v1/me')return {status:200,body:{openid:token==='v1.login.signature'?'p_login':'p_restore',permissions:[],uploads_enabled:true,banks:[]}};
   throw Error(path);
 }});
 const restoring=client.restoreSession();
 await new Promise(resolve=>setTimeout(resolve,0));
 const logged=await client.loginPassword('13812345678','StrongPass123');
 assert.equal(logged.openid,'p_login');
 releaseRestore();
 await assert.rejects(restoring,/登录状态已改变/);
 assert.equal(client.state().openid,'p_login');
 assert.equal(authStorage.get(storageKey),newRefresh);
});

test('Mini Program registration validates and submits the shared phone/password form',async()=>{
 const requests=[];
 const client=createCloudClient({origin:()=> 'https://qbank.example.test',request:async(_origin,path,_method,body)=>{
  requests.push({path,body});
  if(path==='/v1/auth/register')return {status:201,body:{account:{id:'account',phone:'+861****5678',status:'pending'},application:{id:'application',status:'pending',phone:'+861****5678',...body}}};
  throw Error(path);
 }});
 const form={phone:'13812345678',realName:'张三',nickname:'小星',identity:'  ',password:'StrongPass123',passwordConfirm:'StrongPass123'};
 await assert.rejects(()=>client.registerMaintainer(bankId,form),/身份说明/);
 await assert.rejects(()=>client.registerMaintainer(bankId,{...form,identity:'字'.repeat(501)}),/身份说明/);
 assert.equal(requests.length,0);
 const application=await client.registerMaintainer(bankId,{...form,nickname:'小星',identity:'  题库课程助教\n负责勘误  '});
 assert.equal(requests.at(-1).path,'/v1/auth/register');assert.equal(requests.at(-1).body.real_name,'张三');assert.equal(requests.at(-1).body.phone,'13812345678');assert.equal(requests.at(-1).body.nickname,'小星');
 assert.equal(requests.at(-1).body.password,'StrongPass123');assert.equal(application.status,'pending');assert.equal(requests.at(-1).body.identity_description,'题库课程助教\n负责勘误');
});

test('manual form validation names the missing field before any login or request',async()=>{
 const {applicationFields}=load('services/maintainer-application.ts');
 const base={phone:'13812345678',realName:'张三',nickname:'小星',identity:'课程助教'};
 for(const [patch,message] of [[{phone:''},/手机号/],[{realName:' '},/真实姓名/],[{nickname:'a'.repeat(81)},/昵称/],[{identity:''},/身份说明/]])assert.throws(()=>applicationFields({...base,...patch}),message);
 assert.equal(applicationFields({...base,phone:'+86 13812345678'}).phone,'13812345678');
});
test('Mini Program cloud client accepts a configured HTTPS port such as 8013',async()=>{
 let target='';const client=createCloudClient({origin:()=> 'https://qbank.example.test:8013',login:async()=>'',request:async origin=>{target=origin;return {status:200,body:{service:'qbank-auth'}}}});
 await client.health();assert.equal(target,'https://qbank.example.test:8013');
});

test('every build rejects HTTP before service requests and keeps AppID isolation',async()=>{
 const app={appId:'wx22c8135ae81d3acc',envVersion:'develop'};
 const config=load('config/cloud.ts',{wx:{getAccountInfoSync:()=>({miniProgram:app})}});
 let calls=0,target='http://qbank.acharrystar.top:8013';
 const deps={origin:()=>target,request:async()=>{calls++;return {status:200,body:{service:'qbank-auth'}}}};
 const client=createCloudClient(deps);
 await assert.rejects(client.health(),/HTTPS/);
 for(const invalid of ['http://qbank.acharrystar.top:8013','http://other.example.test:8013','http://qbank.acharrystar.top:80','http://qbank.acharrystar.top:8013@other.example.test']){
  target=invalid;await assert.rejects(client.health(),/HTTPS/);
 }
 target='http://qbank.acharrystar.top:8013';
 for(const env of ['develop','trial','release','unknown']){
  app.envVersion=env;assert.equal(config.authOrigin(),config.PRODUCTION_AUTH_ORIGIN);
  await assert.rejects(client.health(),/HTTPS/);
 }
 app.envVersion='develop';app.appId='different-app';assert.equal(config.authOrigin(),'');
 await assert.rejects(client.health(),/HTTPS/);
 assert.equal(calls,0);
});

test('HTTPS failure does not retry transport over HTTP',async()=>{
 const origins=[];
 const client=createCloudClient({origin:()=> 'https://qbank.acharrystar.top:8013',request:async origin=>{origins.push(origin);throw new Error('TLS connection reset');}});
 await assert.rejects(client.health(),/TLS connection reset/);
 assert.deepEqual(origins,['https://qbank.acharrystar.top:8013']);assert.equal(client.state().loggedIn,false);
});
