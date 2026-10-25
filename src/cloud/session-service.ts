/// <reference types="vite/client" />
import {invoke} from '@tauri-apps/api/core';
import {UploadError} from '../../shared/queue';
import desktopService from '../../shared/desktop-service.json';

export type Access={capabilities?:string[];openid?:string;auth_type?:'key'|'password'|'';phone?:string;nickname?:string;account_status?:string;maintainer_id?:string;banks:{bank_id:string;name:string}[];grants:Record<string,string[]>;uploads_enabled:boolean};
type Session={token:string;origin:string;expires:number;access:Access;authType:'key'|'password';refreshToken?:string};
type NativeResponse<T=Record<string,unknown>>={status:number;auth_type?:'key'|'password'|'';body:T&{error?:{message?:string;code?:string}}};
const ORIGIN_KEY='qbank-cloud-origin-v1';
let session:Session|undefined;
let generation=0;
let onLogout=()=>{};
let restoring:Promise<Access|undefined>|undefined;

export function setLogoutHandler(handler:()=>void){onLogout=handler}
export function sessionGeneration(){return generation}
export function cloudOrigin(){return localStorage.getItem(ORIGIN_KEY)||import.meta.env.VITE_QBANK_API_ORIGIN||desktopService.origin;}
export function setCloudOrigin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('请填写不带路径的 HTTPS 地址');
 localStorage.setItem(ORIGIN_KEY,u.origin);session=undefined;generation++;}
export function cloudAccess(){if(session&&session.origin!==cloudOrigin()){session=undefined;generation++;}return session?.access;}
const rememberKey=(origin=cloudOrigin())=>'qbank-remember:'+origin;
function queueCredential(command:string,args:Record<string,unknown>){return invoke(command,args);}
export async function cloudForget(){const origin=cloudOrigin();localStorage.removeItem(rememberKey(origin));await Promise.all([
 queueCredential('credential_save',{origin,key:null}),queueCredential('credential_refresh_save',{origin,refreshToken:null}),
]);}

function clearSession(clearStored=false){const origin=session?.origin||cloudOrigin();session=undefined;generation++;onLogout();
 if(clearStored)void Promise.all([queueCredential('credential_save',{origin,key:null}),queueCredential('credential_refresh_save',{origin,refreshToken:null})]).catch(()=>{});
}
export async function cloudLogout(){
 const origin=session?.origin||cloudOrigin();session=undefined;generation++;onLogout();localStorage.removeItem(rememberKey(origin));
 await queueCredential('credential_logout',{origin});
}

async function nativeRequest<T>(origin:string,path:string,body?:unknown,token?:string):Promise<NativeResponse<T>>{
 return invoke<NativeResponse<T>>('cloud_request',{origin,path,body:body??null,token:token??null}).catch(e=>{
  const message=typeof e?.message==='string'?e.message:String(e);
  throw new UploadError(message,0,message.startsWith('NETWORK:')?'NETWORK':'NATIVE_REQUEST_FAILED');
 });
}
function assertResponse<T>(response:NativeResponse<T>,sessionForRequest?:Session){
 if(response.status<200||response.status>=300){
  if((response.status===401||response.body.error?.code==='MAINTAINER_REVOKED')&&sessionForRequest&&session===sessionForRequest)clearSession(true);
  throw new UploadError(response.body.error?.message||'自托管服务请求未完成，请重试',response.status,response.body.error?.code);
 }
 return response.body;
}

async function renewSession(current:Session):Promise<Access>{
 const origin=current.origin,attempt=generation;
 let response:NativeResponse<{access_token:string;expires_in:number;openid?:string;phone?:string;status?:string;banks?:Access['banks'];permissions?:string[]}>;
 if(current.authType==='password'&&current.refreshToken){
  response=await nativeRequest(origin,'/v1/auth/refresh',{refresh_token:current.refreshToken});
 }else{
  response=await invoke<NativeResponse<{access_token:string;expires_in:number;openid?:string;phone?:string;status?:string; banks?:Access['banks'];permissions?:string[]}>>('credential_resume',{origin});
 }
 const result=assertResponse(response,current);
 if(typeof result.access_token!=='string'||!/^v1\.[\w-]+\.[\w-]+$/.test(result.access_token)||!Number.isInteger(result.expires_in)||result.expires_in<1||result.expires_in>900)
  throw new UploadError('登录续期响应无效，请重新登录',401,'SESSION_INVALID');
 const renewed:Session={...current,token:result.access_token,expires:Date.now()+result.expires_in*1000};
 if(session!==current||attempt!==generation||cloudOrigin()!==origin)throw new UploadError('登录状态已改变，请重试',401,'SIGNED_OUT');
 session=renewed;
 try{
  const access=assertResponse(await nativeRequest<Access>(origin,'/v1/me',undefined,renewed.token),renewed);
  if(!Array.isArray(access.banks)||!access.grants)throw new Error('维护权限响应无效');
  if(session===renewed)renewed.access=access;
  return access;
 }catch(error){if(session===renewed)clearSession(true);throw error;}
}

export async function cloudCall<T>(path:string,body?:unknown,authenticated=false):Promise<T>{
 const origin=cloudOrigin();if(!origin)throw Error('请先配置云端 HTTPS 服务地址');
 let current=session;
 if(authenticated){
  if(!current||current.origin!==origin){await resumePersistentSession();current=session;}
  if(!current)throw new UploadError('请先使用手机号和密码登录',401,'SIGNED_OUT');
  if(current.expires<Date.now()+15000){await renewSession(current);current=session;}
  if(!current||current.origin!==origin)throw new UploadError('登录已失效，请重新登录',401,'SIGNED_OUT');
 }
 return assertResponse(await nativeRequest<T>(origin,path,body,authenticated?current!.token:undefined),authenticated?current:undefined);
}

export async function refreshAccess(){
 const current=session;if(!current)return undefined;
 const access=await cloudCall<Access>('/v1/me',undefined,true);
 if(current===session)current.access=access;
 return access;
}

async function acceptLogin(result:{access_token:string;expires_in:number;refresh_token?:string},attempt:number,origin:string,started:number,authType:'key'|'password'='key'){
 if(!/^v1\.[\w-]+\.[\w-]+$/.test(result.access_token)||result.expires_in<1||result.expires_in>900||origin!==cloudOrigin()||attempt!==generation)throw Error('登录响应无效');
 const candidate:Session={token:result.access_token,origin,expires:started+result.expires_in*1000,access:{banks:[],grants:{},uploads_enabled:false},authType,refreshToken:result.refresh_token};
 session=candidate;
 try{const me=await cloudCall<Access>('/v1/me',undefined,true);if(!Array.isArray(me.banks)||!me.grants)throw Error('维护权限响应无效');if(attempt!==generation||session!==candidate)throw Error('登录已取消，请重新验证');candidate.access=me;return me;}
 catch(e){if(attempt===generation&&session===candidate)session=undefined;throw e;}
}

export async function cloudLogin(key:string){
 session=undefined;const attempt=++generation,origin=cloudOrigin(),started=Date.now();
 const result=await cloudCall<{access_token:string;expires_in:number}>('/v1/auth/desktop',{key});
 await queueCredential('credential_save',{origin,key});
 if(attempt!==generation||origin!==cloudOrigin()){await queueCredential('credential_save',{origin,key:null});throw Error('登录已取消，请重试');}
 try{return await acceptLogin(result,attempt,origin,started,'key');}
 catch(error){await queueCredential('credential_save',{origin,key:null});throw error;}
}

export async function cloudLoginPassword(phone:string,password:string){
 session=undefined;const attempt=++generation,origin=cloudOrigin(),started=Date.now();
 const result=await cloudCall<{access_token:string;refresh_token:string;expires_in:number}>('/v1/auth/password-login',{phone,password});
 if(typeof result.refresh_token!=='string'||!/^r1\.[A-Za-z0-9_-]{43}$/.test(result.refresh_token))throw Error('服务端没有返回有效的登录续期凭据');
 await queueCredential('credential_refresh_save',{origin,refreshToken:result.refresh_token});
 if(attempt!==generation||origin!==cloudOrigin()){await queueCredential('credential_refresh_save',{origin,refreshToken:null});throw Error('登录已取消，请重试');}
 try{return await acceptLogin(result,attempt,origin,started,'password');}
 catch(error){await queueCredential('credential_refresh_save',{origin,refreshToken:null});throw error;}
}

export type MaintainerCertificate={format:'qbank-maintainer-certificate-1';key:string;certificate_id:string;maintainer_id?:string;roles?:string[];issued_at?:string;expires_at?:string;service_origin?:string};
export function parseMaintainerCertificate(value:unknown):MaintainerCertificate{
 const v=value as Record<string,unknown>;
 if(!v||v.format!=='qbank-maintainer-certificate-1'||typeof v.key!=='string'||v.key.length<16||v.key.length>2048||typeof v.certificate_id!=='string'||!v.certificate_id.trim())throw Error('证书格式无效');
 if(v.expires_at&&(!Number.isFinite(Date.parse(String(v.expires_at)))||Date.parse(String(v.expires_at))<=Date.now()))throw Error('证书已过期');
 return {format:'qbank-maintainer-certificate-1',key:v.key,certificate_id:v.certificate_id,maintainer_id:typeof v.maintainer_id==='string'?v.maintainer_id:undefined,roles:Array.isArray(v.roles)?v.roles.filter(x=>typeof x==='string'):undefined,issued_at:typeof v.issued_at==='string'?v.issued_at:undefined,expires_at:typeof v.expires_at==='string'?v.expires_at:undefined,service_origin:typeof v.service_origin==='string'?v.service_origin:undefined};
}

export function resumePersistentSession():Promise<Access|undefined>{
 const current=session;
 if(current&&current.origin===cloudOrigin())return current.expires<Date.now()+15000?renewSession(current):Promise.resolve(current.access);
 if(restoring)return restoring;
 const attempt=++generation,origin=cloudOrigin();
 const task=(async()=>{
  const response=await invoke<NativeResponse<{access_token:string;expires_in:number;openid?:string;phone?:string;status?:string; banks?:Access['banks'];permissions?:string[]}>>('credential_resume',{origin});
  if(response.status===401||response.status===403)return undefined;
  const result=assertResponse(response);
  if(response.auth_type!=='key'&&response.auth_type!=='password')throw Error('本机登录凭据类型无效');
  return acceptLogin(result,attempt,origin,Date.now(),response.auth_type);
 })();
 restoring=task;void task.finally(()=>{if(restoring===task)restoring=undefined}).catch(()=>{});return task;
}
export const resumeDesktop=resumePersistentSession;

export async function cloudInitializePersistentSession(){
 try{return await resumePersistentSession();}catch(error){if(error instanceof UploadError&&error.status===401)return undefined;throw error;}
}
