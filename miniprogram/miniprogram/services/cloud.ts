import {UploadError} from '../core/queue';
import {authOrigin} from '../config/cloud';
import {prepareUpload,verifyReceipt} from '../core/upload';
type Bank={bank_id:string;name:string};
type Session={openid:string;token:string;origin:string;expiresAt:number;banks:Bank[];uploadsEnabled:boolean};
type Response={status:number;body:unknown};
type Transport=(origin:string,path:string,method:'GET'|'POST',body:unknown,token?:string)=>Promise<Response>;
export type CloudAccess={openid?:string;configured:boolean;loggedIn:boolean;banks:Bank[];uploadsEnabled:boolean};
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('云端响应无效，请稍后重试');
  return value as Record<string,unknown>;
}
function readBanks(value:unknown):Bank[]{
  if(!Array.isArray(value)||value.length>100)throw new Error('云端题库权限无效');
  const seen=new Set<string>();
  return value.map(item=>{const b=object(item);
    if(typeof b.bank_id!=='string'||!UUID.test(b.bank_id)||seen.has(b.bank_id)||typeof b.name!=='string'||!b.name.trim()||b.name.length>200)
      throw new Error('云端题库权限无效');
    seen.add(b.bank_id);return {bank_id:b.bank_id,name:b.name};});
}
const messages:Record<string,string>={
  DEVELOPER_NOT_ALLOWED:'此微信账号尚未获得开发者上传授权，请联系题库维护者',
  BANK_FORBIDDEN:'没有当前题库的上传权限，请重新登录确认授权',
  BANK_NAME_MISMATCH:'题库名称与云端目录不一致，请联系题库维护者',
  UPLOAD_DISABLED:'上传服务暂未开放，本地题目仍然保留',
  RATE_LIMITED:'操作较频繁，请稍后重试',
  BATCH_CONFLICT:'云端已有此批次的不同内容，请联系维护者核对；本地题目已保留',
  PACKAGE_INVALID:'上传包校验失败，本地批次已保留，请联系维护者',
  QUESTION_INVALID:'题目或模型来源不符合上传要求，请核对录入内容',
  STORAGE_UNAVAILABLE:'云端保存未确认，请重试本批次，不要重新录入',
  ORIGIN_DENIED:'当前请求来源尚未配置，请联系维护者',
};

// Tokens stay in the service closure, never in Page.data, storage, exports or logs.
export function createCloudClient(deps:{origin:()=>string;login:()=>Promise<string>;request:Transport;now?:()=>number}){
  let session:Session|undefined, pending:Promise<CloudAccess>|undefined, generation=0;
  const now=deps.now||Date.now;
  function origin(){const value=deps.origin();
    if(!/^https:\/\/[a-z0-9.-]+(?::443)?$/i.test(value))throw new Error('云端上传尚未配置，仍可本地录题、导出和分享');
    return value;}
  function active(){if(session&&(session.expiresAt<=now()+15000||session.origin!==deps.origin()))session=undefined;return session;}
  function state():CloudAccess {const current=active();return {openid:current?.openid,configured:!!deps.origin(),loggedIn:!!current,
    banks:current?current.banks.map(b=>({...b})):[],uploadsEnabled:current?.uploadsEnabled||false};}
  function logout(){generation++;session=undefined;pending=undefined;}
  async function call(path:string,method:'GET'|'POST',body:unknown,current?:Session):Promise<Response>{
    const response=await deps.request(current?.origin||origin(),path,method,body,current?.token);
    if(response.status<200||response.status>=300){
      const error=object(object(response.body).error),code=typeof error.code==='string'?error.code:'';
      if(response.status===401||code==='DEVELOPER_NOT_ALLOWED'||code==='BANK_FORBIDDEN')logout();
      throw new UploadError(response.status===401?'登录已失效，请重新登录后重试':messages[code]||'云端请求未完成，请保留本地批次后重试',response.status,code);
    }
    return response;
  }
  function login():Promise<CloudAccess>{
    if(pending)return pending;
    const run=(async()=>{
      const base=origin(),epoch=generation,started=now();session=undefined;
      const code=await deps.login();
      if(!/^[A-Za-z0-9_-]{8,256}$/.test(code))throw new Error('未取得微信登录凭证，请重试');
      const result=object((await call('/v1/auth/wechat','POST',{code})).body);
      if(typeof result.access_token!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.access_token)
        ||result.access_token.length>4096||!Number.isInteger(result.expires_in)||Number(result.expires_in)<30||Number(result.expires_in)>900)
        throw new Error('云端登录响应无效，请重试');
      const current:Session={openid:result.openid as string,token:result.access_token,origin:base,expiresAt:started+Number(result.expires_in)*1000,banks:readBanks(result.banks),uploadsEnabled:false};
      const me=object((await call('/v1/me','GET',undefined,current)).body);
      if(typeof result.openid!=='string'||me.openid!==result.openid||!Array.isArray(me.permissions)||!me.permissions.includes('upload')||typeof me.uploads_enabled!=='boolean')
        throw new Error('云端身份或权限校验失败，请重新登录');
      current.banks=readBanks(me.banks);current.uploadsEnabled=me.uploads_enabled;
      if(epoch!==generation||base!==deps.origin())throw new Error('登录已取消，请重新登录');
      session=current;return state();
    })();
    pending=run;void run.finally(()=>{if(pending===run)pending=undefined;}).catch(()=>{});return run;
  }
  async function authorize(bankId:string,name:string){
    if(!active())await login();
    const current=active();if(!current)throw new Error('登录已失效，请重新登录');
    const me=object((await call('/v1/me','GET',undefined,current)).body);
    if(!Array.isArray(me.permissions)||!me.permissions.includes('upload')||typeof me.uploads_enabled!=='boolean')throw new Error('云端权限响应无效');
    if(active()!==current||me.openid!==current.openid)throw new UploadError('登录已取消或身份改变',401,'SIGNED_OUT');
    const banks=readBanks(me.banks);current.banks=banks;current.uploadsEnabled=me.uploads_enabled;
    const bank=banks.find(b=>b.bank_id===bankId);
    if(!bank)throw new UploadError('没有当前题库的上传权限；本地新建的题库需先由维护者授权',403,'BANK_FORBIDDEN');
    if(bank.name!==name)throw new Error(messages.BANK_NAME_MISMATCH);
    if(!current.uploadsEnabled)throw new UploadError(messages.UPLOAD_DISABLED,503,'UPLOAD_DISABLED');
    return current.origin;
  }
  async function upload(expected:ReturnType<typeof prepareUpload>,expectedOrigin:string,confirmed=false){
    const current=active();if(!current||current.origin!==expectedOrigin)throw new Error('登录已失效或服务地址改变，请重新登录后重试');
    const response=await call('/v1/uploads','POST',confirmed?{format:'qbank-confirmed-upload-1',package:expected.envelope}:expected.envelope,current),body=object(response.body);
    if(!((response.status===201&&body.duplicate===false)||(response.status===200&&body.duplicate===true)))throw new Error('云端上传响应无效，请重试本批次');
    return {receipt:verifyReceipt(body.receipt,expected),duplicate:body.duplicate as boolean};
  }
  async function health(){return object((await call('/health','GET',undefined)).body)}
  return {state,login,logout,authorize,upload,health};
}

const request:Transport=(origin,path,method,body,token)=>new Promise((resolve,reject)=>{
  wx.request({url:origin+path,method,data:body===undefined?undefined:JSON.stringify(body),dataType:'json',responseType:'text',timeout:20000,
    header:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
    success:r=>{try{const text=typeof r.data==='string'?r.data:JSON.stringify(r.data);
      if(!text||text.length>65536)throw new Error('云端响应无效');
      resolve({status:r.statusCode,body:JSON.parse(text)});}catch{reject(new Error('云端响应无法识别，请保留本地批次后重试'));}},
    fail:e=>reject(new Error(/url not in domain|不在.*合法域名|domain list/i.test(e.errMsg)?'上传域名尚未加入小程序合法域名，请联系维护者配置':'网络请求未完成，本地题目已保留；请重试本批次'))});
});
export const cloud=createCloudClient({origin:authOrigin,request,login:()=>new Promise((resolve,reject)=>wx.login({timeout:10000,
  success:r=>r.code?resolve(r.code):reject(new Error('微信登录失败，请重试')),fail:()=>reject(new Error('微信登录失败，请确认网络后重试'))}))});
