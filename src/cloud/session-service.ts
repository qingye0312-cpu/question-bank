/// <reference types="vite/client" />
import {invoke} from '@tauri-apps/api/core';
import {UploadError} from '../../shared/queue';
import desktopService from '../../shared/desktop-service.json';
export type Access={capabilities?:string[];openid?:string;phone?:string;nickname?:string;account_status?:string;maintainer_id?:string;banks:{bank_id:string;name:string}[];grants:Record<string,string[]>;uploads_enabled:boolean};
type Session={token:string;origin:string;expires:number;access:Access};
const ORIGIN_KEY='qbank-cloud-origin-v1';
let session:Session|undefined;
let generation=0;
let onLogout=()=>{};
export function setLogoutHandler(handler:()=>void){onLogout=handler}
export function sessionGeneration(){return generation}
export async function refreshAccess(){const current=session;if(!current)return;const access=await cloudCall<Access>('/v1/me',undefined,true);if(current===session)session.access=access;return access;}
export function cloudOrigin(){return localStorage.getItem(ORIGIN_KEY)||import.meta.env.VITE_QBANK_API_ORIGIN||desktopService.origin;}
export function setCloudOrigin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('请填写不带路径的 HTTPS 地址');
 localStorage.setItem(ORIGIN_KEY,u.origin);session=undefined;generation++;}
export function cloudAccess(){if(session&&(session.expires<Date.now()+15000||session.origin!==cloudOrigin()))session=undefined;return session?.access;}
const rememberKey=(origin=cloudOrigin())=>'qbank-remember:'+origin;
export function remembersMachine(){return localStorage.getItem(rememberKey())==='yes';}
let credentialWrite:Promise<unknown>=Promise.resolve();
function storeCredential(origin:string,key:string|null){const task=credentialWrite.catch(()=>{}).then(()=>invoke('credential_save',{origin,key}));credentialWrite=task;return task;}
export async function cloudForget(){const origin=cloudOrigin();localStorage.removeItem(rememberKey(origin));await storeCredential(origin,null);}
export function cloudLogout(){session=undefined;generation++;onLogout();if(remembersMachine())void cloudForget().catch(()=>{});}

export async function cloudCall<T>(path:string,body?:unknown,authenticated=false):Promise<T>{
 const origin=cloudOrigin();if(!origin)throw Error('请先配置云端 HTTPS 服务地址');
 if(authenticated&&!cloudAccess())throw new UploadError('请先进行维护者登录',401,'SIGNED_OUT');
 const current=session;const response=await invoke<{status:number;body:T&{error?:{message?:string;code?:string}}}>('cloud_request',{origin,path,body:body??null,token:authenticated?session!.token:null}).catch(e=>{const message=typeof e?.message==='string'?e.message:String(e);throw new UploadError(message,0,message.startsWith('NETWORK:')?'NETWORK':'NATIVE_REQUEST_FAILED')});
 if(response.status<200||response.status>=300){if((response.status===401||response.body.error?.code==='MAINTAINER_REVOKED')&&session===current)cloudLogout();throw new UploadError(response.body.error?.message||'自托管服务请求未完成，请重试',response.status,response.body.error?.code);}return response.body;
}
async function acceptLogin(result:{access_token:string;expires_in:number},attempt:number,origin:string,started:number){
 if(!/^v1\.[\w-]+\.[\w-]+$/.test(result.access_token)||result.expires_in<1||result.expires_in>900||origin!==cloudOrigin()||attempt!==generation)throw Error('登录响应无效');
 session={token:result.access_token,origin,expires:started+result.expires_in*1000,access:{banks:[],grants:{},uploads_enabled:false}};
 try{const me=await cloudCall<Access>('/v1/me',undefined,true);if(!Array.isArray(me.banks)||!me.grants)throw Error('维护权限响应无效');if(attempt!==generation||!session)throw Error('登录已取消，请重新验证');session.access=me;return me;}catch(e){if(attempt===generation)session=undefined;throw e;}
}
export async function cloudLogin(key:string,remember=false){
 session=undefined;const attempt=++generation,origin=cloudOrigin(),started=Date.now();
 const result=await cloudCall<{access_token:string;expires_in:number}>('/v1/auth/desktop',{key});
 const me=await acceptLogin(result,attempt,origin,started);
 if(remember){await storeCredential(origin,key);if(attempt!==generation||origin!==cloudOrigin()){await storeCredential(origin,null);throw Error('登录已取消，本机凭据已清除');}localStorage.setItem(rememberKey(origin),'yes');}
 else if(remembersMachine())await cloudForget();
 return me;
}
export type MaintainerCertificate={format:'qbank-maintainer-certificate-1';key:string;certificate_id:string;maintainer_id?:string;roles?:string[];issued_at?:string;expires_at?:string;service_origin?:string};
export function parseMaintainerCertificate(value:unknown):MaintainerCertificate{
 const v=value as Record<string,unknown>;
 if(!v||v.format!=='qbank-maintainer-certificate-1'||typeof v.key!=='string'||v.key.length<16||v.key.length>2048||typeof v.certificate_id!=='string'||!v.certificate_id.trim())throw Error('证书格式无效');
 if(v.expires_at&&(!Number.isFinite(Date.parse(String(v.expires_at)))||Date.parse(String(v.expires_at))<=Date.now()))throw Error('证书已过期');
 return {format:'qbank-maintainer-certificate-1',key:v.key,certificate_id:v.certificate_id,maintainer_id:typeof v.maintainer_id==='string'?v.maintainer_id:undefined,roles:Array.isArray(v.roles)?v.roles.filter(x=>typeof x==='string'):undefined,issued_at:typeof v.issued_at==='string'?v.issued_at:undefined,expires_at:typeof v.expires_at==='string'?v.expires_at:undefined,service_origin:typeof v.service_origin==='string'?v.service_origin:undefined};
}
let renewing:Promise<Access|undefined>|undefined;
export function resumeDesktop():Promise<Access|undefined>{
 if(cloudAccess())return Promise.resolve(cloudAccess());if(!remembersMachine())return Promise.resolve(undefined);if(renewing)return renewing;
 const attempt=++generation,origin=cloudOrigin(),started=Date.now();
 const task=(async()=>{const response=await invoke<{status:number;body:{access_token:string;expires_in:number}}>('credential_login',{origin});
  if(response.status!==200){if(response.status===401||response.status===403){if(attempt===generation)cloudLogout();}throw new UploadError('本机凭据无法完成登录，请手动验证',response.status);}
  return acceptLogin(response.body,attempt,origin,started);
 })();renewing=task;void task.finally(()=>{if(renewing===task)renewing=undefined}).catch(()=>{});return task;
}
