import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {signedRequest,originFrom,deploy,verify} from '../tools/cloud/ops.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
test('management requests use deterministic TC3 signatures and reject unbounded endpoint URLs',()=>{
 const env={TENCENTCLOUD_SECRET_ID:'unit-id',TENCENTCLOUD_SECRET_KEY:'secret-never-log',TENCENTCLOUD_SESSIONTOKEN:'session'};
 const r=signedRequest('GetFunction',{FunctionName:'qbank-auth'},env,1792281600000);
 assert.match(r.headers.Authorization,/^TC3-HMAC-SHA256 Credential=unit-id\/2026-10-18\/scf\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f0-9]{64}$/);
 assert.equal(r.headers['X-TC-Token'],'session');assert.ok(!JSON.stringify(r).includes(env.TENCENTCLOUD_SECRET_KEY));assert.deepEqual(r,signedRequest('GetFunction',{FunctionName:'qbank-auth'},env,1792281600000));
 for(const v of ['http://x.test','https://u:p@x.test','https://x.test/path','https://x.test?token=private'])assert.throws(()=>originFrom({QBANK_API_ORIGIN:v}));
});
async function simulation(fail=false,foreign=false){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'qbank-deploy-')),old=Buffer.from('PK old code'),code=Buffer.from('PK new code'),zip=path.join(dir,'new.zip');await fs.writeFile(zip,code);let active=old;const calls=[];
 const api=async(action,body)=>{calls.push({action,body});if(action==='GetFunction')return {Status:'Active',Runtime:'Nodejs20.19',Handler:'index.main_handler'};
  if(action==='GetFunctionAddress')return {Url:'https://test.cos.ap-guangzhou.myqcloud.com/code?secret=private',CodeSha256:hash(active)};
  if(action==='UpdateFunctionCode'){active=Buffer.from(body.ZipFile,'base64');return {};}};
 const options={env:{QBANK_API_ORIGIN:'https://unit.test'},api,zip,directory:path.join(dir,'backups'),request:async()=>new Response(old),wait:async()=>{},check:async()=>{if(fail){if(foreign)active=Buffer.from('PK a third party deployment');throw Error('capabilities missing');}}};
 return {dir,old,code,calls,options,active:()=>active};
}
test('deployment backs up exact bytes, verifies code and health, and sends no role or environment changes',async t=>{
 const s=await simulation();t.after(()=>fs.rm(s.dir,{recursive:true,force:true}));const result=await deploy(s.options);
 assert.equal(result.status,'verified');assert.deepEqual(await fs.readFile(result.backupPath),s.old);assert.deepEqual(s.active(),s.code);
 const writes=s.calls.filter(c=>c.action==='UpdateFunctionCode');assert.equal(writes.length,1);assert.deepEqual(Object.keys(writes[0].body).sort(),['CodeSource','FunctionName','Handler','Namespace','Publish','ZipFile']);
});
test('failed verification restores the old code; a concurrent foreign deployment is never overwritten',async t=>{
 for(const foreign of [false,true]){const s=await simulation(true,foreign);t.after(()=>fs.rm(s.dir,{recursive:true,force:true}));await assert.rejects(deploy(s.options),foreign?/恢复未确认/:/原代码已按摘要恢复/);assert.equal(s.calls.filter(c=>c.action==='UpdateFunctionCode').length,foreign?1:2);if(!foreign)assert.deepEqual(s.active(),s.old);}
});
test('verify checks protocol and refuses anonymous-upload misconfiguration',async()=>{
 const health={service:'qbank-auth',version:'0.2.7',auth_configured:true,uploads_enabled:true,capabilities:['confirmed-upload-v1','snapshot-v2','recorded-at-v1','merge-v1']};
 const request=async(url)=>new Response(JSON.stringify(url.endsWith('/health')?health:{banks:[]}),{status:url.endsWith('/uploads')?401:200});
 assert.equal((await verify({QBANK_API_ORIGIN:'https://unit.test'},request)).anonymous_upload,'rejected');
 health.capabilities=[];await assert.rejects(verify({QBANK_API_ORIGIN:'https://unit.test'},request),/新协议/);
});
