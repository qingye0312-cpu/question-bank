// Tencent Cloud API 3.0 operations. Never print provider bodies, credentials,
// code download URLs or environment-variable values.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {readManifest,readSnapshot} from '../../shared/sync.ts';
const digest=v=>createHash('sha256').update(v).digest('hex');
const hmac=(k,v)=>createHmac('sha256',k).update(v).digest();
const requiredCapabilities=['confirmed-upload-v1','snapshot-v2','recorded-at-v1','merge-v1'];
export function signedRequest(action,params,env=process.env,now=Date.now()){
 const id=env.TENCENTCLOUD_SECRET_ID||env.TENCENTCLOUD_SECRETID,key=env.TENCENTCLOUD_SECRET_KEY||env.TENCENTCLOUD_SECRETKEY;
 if(!id||!key)throw Error('缺少管理 API 凭据；请在本机环境变量设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
 const body=JSON.stringify(params),timestamp=Math.floor(now/1000),date=new Date(now).toISOString().slice(0,10),host='scf.tencentcloudapi.com',scope=`${date}/scf/tc3_request`;
 const canonical=`POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${digest(body)}`;
 const signature=hmac(hmac(hmac(hmac('TC3'+key,date),'scf'),'tc3_request'),`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${digest(canonical)}`).toString('hex');
 return {method:'POST',body,headers:{'content-type':'application/json; charset=utf-8','X-TC-Action':action,'X-TC-Version':'2018-04-16','X-TC-Timestamp':String(timestamp),'X-TC-Region':env.QBANK_CLOUD_REGION||'ap-guangzhou',Authorization:`TC3-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,...env.TENCENTCLOUD_SESSIONTOKEN?{'X-TC-Token':env.TENCENTCLOUD_SESSIONTOKEN}:{}}};
}
export function originFrom(env=process.env){const value=env.QBANK_API_ORIGIN;if(!value)throw Error('请设置 QBANK_API_ORIGIN（云函数 HTTPS 地址）');const u=new URL(value);if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('QBANK_API_ORIGIN 必须是不带路径的 HTTPS 地址');return u.origin;}
async function jsonResponse(r){if(!r.ok)throw Error(`HTTP ${r.status}`);const text=await r.text();if(text.length>8*1024*1024)throw Error('响应超过大小限制');return JSON.parse(text);}
export async function scf(action,params,env=process.env,request=fetch){
 const r=await jsonResponse(await request('https://scf.tencentcloudapi.com', {...signedRequest(action,params,env),signal:AbortSignal.timeout(30000),redirect:'error'}));
 if(r.Response?.Error)throw Error(`腾讯云 ${action}: ${r.Response.Error.Code}（RequestId ${r.Response.RequestId||'unknown'}）`);
 if(!r.Response)throw Error('腾讯云响应格式无效');return r.Response;
}
export async function verify(env=process.env,request=fetch){
 const origin=originFrom(env),get=async p=>jsonResponse(await request(origin+p,{signal:AbortSignal.timeout(20000),redirect:'error'}));
 const health=await get('/health');if(health.service!=='qbank-auth')throw Error('此地址不是 qbank-auth');
 const missing=requiredCapabilities.filter(v=>!health.capabilities?.includes(v));
 if(missing.length)throw Error('云端代码尚未具备新协议：'+missing.join(', '));
 if(!health.auth_configured||!health.uploads_enabled)throw Error('鉴权或上传尚未开启，请检查控制台配置');
 const result=await get('/v1/catalog');if(!Array.isArray(result.banks))throw Error('云端目录无效');
 for(const value of result.banks){const m=readManifest(value);if(m.revision>0)readSnapshot(await get(`/v1/banks/${m.bank_id}/snapshot`),m);}
 // Check enforcement with an invalid token, without creating data.
 const denied=await request(origin+'/v1/uploads',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(20000),redirect:'error'});
 if(denied.status!==401)throw Error('匿名上传未被预期的鉴权规则拒绝');
 return {service:health.service,version:health.version,capabilities:requiredCapabilities,banks:result.banks.map(b=>({bank_id:b.bank_id,revision:b.revision,release_version:b.release_version,release_name:b.release_name})),anonymous_upload:'rejected',production_domain:!origin.endsWith('.tencentscf.com')};
}
export async function deploy({env=process.env,api=(a,p)=>scf(a,p,env),request=fetch,zip='artifacts/cloud/qbank-auth-0.2.7.zip',directory='.local/cloud-deploy',check=()=>verify(env,request),wait=delay}={}){
 const FunctionName=env.QBANK_FUNCTION_NAME||'qbank-auth',Namespace=env.QBANK_NAMESPACE||'default',target={FunctionName,Namespace};
 if(!env.QBANK_API_ORIGIN)throw Error('部署前必须设置 QBANK_API_ORIGIN 供部署后验证');
 const bytes=await fs.readFile(zip);if(bytes.length>20*1024*1024||bytes.subarray(0,2).toString()!=='PK')throw Error('部署包无效或超过 20 MiB');
 const info=await api('GetFunction',{...target,ShowCode:'FALSE'});
 if(info.Status!=='Active'||info.Runtime!=='Nodejs20.19'||info.Handler!=='index.main_handler')throw Error('目标函数状态／运行环境／入口与部署包不符，未修改云端');
 const backupInfo=await api('GetFunctionAddress',target),u=new URL(backupInfo.Url);
 // The API may return an HTTP COS URL; use TLS, never log the signed URL.
 if(!/\.(myqcloud\.com|tencentcos\.cn)$/.test(u.hostname))throw Error('代码备份地址不是腾讯云 COS');u.protocol='https:';
 const response=await request(u,{signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok)throw Error('原代码备份下载失败，未部署');
 const backup=Buffer.from(await response.arrayBuffer());if(backup.length>50*1024*1024||backup.subarray(0,2).toString()!=='PK'||!backupInfo.CodeSha256||digest(backup).toLowerCase()!==backupInfo.CodeSha256.toLowerCase())throw Error('原代码备份校验失败，未部署');
 await fs.mkdir(directory,{recursive:true,mode:0o700});const tag=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),backupPath=path.join(directory,tag+'.zip'),recordPath=path.join(directory,tag+'.json');
 await fs.writeFile(backupPath,backup,{flag:'wx',mode:0o600});
 const record={target,region:env.QBANK_CLOUD_REGION||'ap-guangzhou',before_sha256:digest(backup),after_sha256:digest(bytes),backup:backupPath,status:'prepared'};
 const save=()=>fs.writeFile(recordPath,JSON.stringify(record,null,2),{mode:0o600});await save();
 const waitActive=async()=>{for(let i=0;i<30;i++){const current=await api('GetFunction',{...target,ShowCode:'FALSE'});if(current.Status==='Active')return;if(/Failed/.test(current.Status))throw Error('云函数部署失败');await wait(2000);}throw Error('云函数部署状态未确认');};
 try{
  record.status='updating';await save();
  await api('UpdateFunctionCode',{...target,ZipFile:bytes.toString('base64'),CodeSource:'ZipFile',Handler:'index.main_handler',Publish:'FALSE'});
  await waitActive();
  const deployed=await api('GetFunctionAddress',target);if(deployed.CodeSha256?.toLowerCase()!==digest(bytes))throw Error('云端代码摘要与本地部署包不一致');
  await check();record.status='verified';await save();return {status:record.status,recordPath,backupPath,sha256:record.after_sha256};
 }catch(error){
  record.status='verification-failed';await save();
  // Restore code only. Roles, environment variables, function URL and data are
  // deliberately absent from UpdateFunctionCode and remain untouched.
  try{await waitActive();const current=await api('GetFunctionAddress',target);if(![record.before_sha256,record.after_sha256].includes(current.CodeSha256?.toLowerCase()))throw Error('云端出现其他代码版本，停止自动恢复');await api('UpdateFunctionCode',{...target,ZipFile:backup.toString('base64'),CodeSource:'ZipFile',Handler:info.Handler,Publish:'FALSE'});await waitActive();const restored=await api('GetFunctionAddress',target);if(restored.CodeSha256?.toLowerCase()!==digest(backup))throw Error();record.status='rolled-back';await save();}
  catch{record.status='restore-needed';await save();throw Error(`部署未验证且恢复未确认。请保留 ${recordPath}，使用备份 ${backupPath} 在控制台恢复。`);}
  throw Error(`新代码未通过验证，原代码已按摘要恢复。诊断：${error.message}；记录：${recordPath}`);
 }
}
async function main(){const action=process.argv[2],env=process.env;
 if(action==='doctor'){
  const checks={management_credentials:!!((env.TENCENTCLOUD_SECRET_ID||env.TENCENTCLOUD_SECRETID)&&(env.TENCENTCLOUD_SECRET_KEY||env.TENCENTCLOUD_SECRETKEY)),origin_configured:!!env.QBANK_API_ORIGIN,function:env.QBANK_FUNCTION_NAME||'qbank-auth',region:env.QBANK_CLOUD_REGION||'ap-guangzhou'};
  if(env.QBANK_API_ORIGIN){try{checks.live=await verify(env);}catch(e){checks.live_error=e.message;}}
  console.log(JSON.stringify(checks,null,2));return;
 }
 if(action==='verify'){console.log(JSON.stringify(await verify(env),null,2));return;}
 if(action==='deploy'){
  if(process.argv.includes('--dry-run')){const file='artifacts/cloud/qbank-auth-0.2.7.zip',b=await fs.readFile(file);console.log(JSON.stringify({mode:'dry-run',file,bytes:b.length,sha256:digest(b),function:env.QBANK_FUNCTION_NAME||'qbank-auth',region:env.QBANK_CLOUD_REGION||'ap-guangzhou',steps:['backup and hash','update code','verify capabilities and read access','restore previous code on failed verification']},null,2));return;}
  console.log(JSON.stringify(await deploy(),null,2));return;
 }
 throw Error('用法：pnpm cloud:doctor | cloud:verify | cloud:deploy [--dry-run]');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
