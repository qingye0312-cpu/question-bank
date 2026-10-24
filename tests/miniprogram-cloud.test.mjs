import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {gzipSync} from 'node:zlib';
import {parseDelta,sha256} from '../shared/intake.ts';

const root=new URL('../miniprogram/miniprogram/',import.meta.url);
const fixture=fs.readFileSync(new URL('fixtures/intake/mobile-delta.json',import.meta.url),'utf8');

function load(relative){
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
    vm.runInNewContext(compiled,{exports,module:{exports},require:child=>read(new URL(child,url).pathname.replace(root.pathname,'')),console,Uint8Array,Uint16Array,Uint32Array,Int32Array,ArrayBuffer,DataView,Date,Map,Set,Error,Promise,TextDecoder,setTimeout,clearTimeout});
    return exports;
  }
  return read(relative);
}

const {prepareUpload,unpackUpload,verifyReceipt}=load('core/upload.ts');
const {createCloudClient}=load('services/cloud.ts');
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

test('Mini Program client uses phone login, keeps the token private, and sends only the current confirmed upload wrapper',async()=>{
  const requests=[];let loginCalls=0;
  const origin='https://qbank.example.test';
  const bank={bank_id:bankId,name:'跨端测试题库'};
  const client=createCloudClient({origin:()=>origin,login:async()=>{loginCalls++;return 'login-code-123';},request:async(_origin,path,method,body,token)=>{
    requests.push({path,method,body,token});
    if(path==='/v1/auth/wechat-phone')return {status:200,body:{access_token:'v1.token.signature',expires_in:900,openid:'ok-phone',phone:'+8613812345678',status:'approved',banks:[bank]}};
    if(path==='/v1/me')return {status:200,body:{openid:'ok-phone',permissions:['upload'],uploads_enabled:true,banks:[bank]}};
    if(path==='/v1/uploads')return {status:201,body:{duplicate:false,receipt:{submission_id:sha256(`${bankId}/${JSON.parse(fixture).batch_id}`),bank_id:bankId,batch_id:JSON.parse(fixture).batch_id,sha256:body.package.sha256,payload_sha256:JSON.parse(fixture).sha256,question_count:1,status:'merged',accepted_at:'2026-10-24T00:00:00Z',merged_at:'2026-10-24T00:00:01Z',added_count:1,duplicate_count:0,revision:2,release_version:2,release_name:'20261024-080000+0800_跨端测试题库_合并_v2'}}};
    throw new Error(`unexpected ${method} ${path}`);
  }});
  const access=await client.loginWithPhone('phone-code-123','小星');
  assert.equal(access.loggedIn,true);assert.equal(access.banks[0].bank_id,bankId);assert.equal(loginCalls,1);
  assert.equal(await client.authorize(bankId,bank.name),origin);
  const prepared=prepareUpload(fixture),result=await client.upload(prepared,origin);
  assert.equal(result.receipt.status,'merged');assert.equal(result.duplicate,false);
  assert.equal(requests[0].path,'/v1/auth/wechat-phone');assert.equal(requests[0].body.phone_code,'phone-code-123');
  assert.equal(requests.at(-1).body.format,'qbank-confirmed-upload-1');assert.equal(requests.at(-1).body.package.format,'qbank-upload-1');
  assert.equal(client.state().openid,'ok-phone');assert.ok(!JSON.stringify(client.state()).includes('v1.token.signature'));
});

test('Mini Program receipt verification accepts only merged or duplicate results',()=>{
  const expected=prepareUpload(fixture),base={submission_id:sha256(`${bankId}/${expected.delta.batch_id}`),bank_id:bankId,batch_id:expected.delta.batch_id,sha256:expected.envelope.sha256,payload_sha256:expected.delta.sha256,question_count:1,accepted_at:'2026-10-24T00:00:00Z',merged_at:'2026-10-24T00:00:01Z',added_count:1,duplicate_count:0,revision:2,release_version:2,release_name:'20261024-080001_测试库'};
  for(const status of ['merged','duplicate'])assert.equal(verifyReceipt({...base,status},expected).status,status);
  for(const status of ['review','queued'])assert.throws(()=>verifyReceipt({...base,status},expected));
  const complete=verifyReceipt({...base,status:'merged'},expected);assert.equal(complete.merged_at,base.merged_at);assert.equal(complete.revision,2);
  for(const field of ['merged_at','revision','release_version','release_name','added_count','duplicate_count']){const missing={...base,status:'merged'};delete missing[field];assert.throws(()=>verifyReceipt(missing,expected));}
  assert.throws(()=>verifyReceipt({...base,status:'merged',added_count:2},expected));
});

test('Mini Program validates identity before phone login and includes it in the application',async()=>{
 const requests=[];
 const client=createCloudClient({origin:()=> 'https://qbank.example.test',login:async()=> 'phone-login-code',request:async(_origin,path,_method,body)=>{
  requests.push({path,body});
  if(path==='/v1/auth/wechat-phone')return {status:200,body:{access_token:'v1.test.signature',expires_in:900,openid:'ok-phone',phone:'+861****5678',banks:[],status:'pending'}};
  if(path==='/v1/me')return {status:200,body:{openid:'ok-phone',permissions:[],uploads_enabled:true,banks:[]}};
  if(path==='/v1/maintainer-applications')return {status:201,body:{application:{id:'application',status:'pending',phone:'+861****5678',...body}}};
  throw Error(path);
 }});
 await assert.rejects(()=>client.applyMaintainer(bankId,'测试库','phone-code-123','小星','  '),/身份说明/);
 await assert.rejects(()=>client.applyMaintainer(bankId,'测试库','phone-code-123','小星','字'.repeat(501)),/身份说明/);
 assert.equal(requests.length,0);
 const application=await client.applyMaintainer(bankId,'测试库','phone-code-123','小星','  题库课程助教\n负责勘误  ');
 assert.equal(application.status,'pending');assert.equal(requests.at(-1).body.identity_description,'题库课程助教\n负责勘误');
});
