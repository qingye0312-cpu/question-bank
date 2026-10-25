import {UploadError} from '../core/queue';
import {authOrigin} from '../config/cloud';
import {prepareUpload,verifyReceipt} from '../core/upload';
import {applicationFields,passwordMeetsPolicy,registrationFields,type MaintainerForm,type MaintainerRegistrationForm} from './maintainer-application';
type Bank={bank_id:string;name:string};
type Session={openid:string;token:string;origin:string;expiresAt:number;banks:Bank[];uploadsEnabled:boolean;status?:string;phone?:string;nickname?:string;username?:string;authType?:'wechat'|'password'};
type Response={status:number;body:unknown};
type Transport=(origin:string,path:string,method:'GET'|'POST',body:unknown,token?:string)=>Promise<Response>;
export type CloudAccess={openid?:string;username?:string;authType?:'wechat'|'password';status?:string;configured:boolean;loggedIn:boolean;banks:Bank[];uploadsEnabled:boolean};
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
  BANK_FORBIDDEN:'没有当前题库的上传权限，请重新登录确认授权',
  LOGIN_REQUIRED:'请先登录维护者账号',
  WECHAT_LOGIN_REQUIRED:'请先使用维护者账号登录',
  PHONE_INVALID:'请填写有效的 11 位手机号',
  REAL_NAME_REQUIRED:'请填写 1 至 40 字的真实姓名',
  NICKNAME_INVALID:'昵称最多 80 字，可以不填',
  PHONE_IN_USE:'此手机号已绑定其他微信账号，请联系管理员核实',
  PHONE_CHANGE_REQUIRES_ADMIN:'已授权账号修改手机号需联系管理员核实',
  BANKS_REQUIRED:'请选择有效的云端题库；私人本地题库不能申请云端权限',
  WECHAT_UNAVAILABLE:'微信登录校验暂不可用，请联系管理员检查服务端配置',
  IDENTITY_REQUIRED:'请填写 1 至 500 字的身份说明，方便管理员核实',
  USERNAME_INVALID:'账号需为 4 至 32 位字母、数字、点、下划线或连字符',
  USERNAME_TAKEN:'此账号已注册，请直接登录',
  PASSWORD_INVALID:'密码至少 8 位，且需包含大写字母、小写字母和数字',
  CREDENTIALS_INVALID:'账号或密码不正确',
  PASSWORD_RESET_INVALID:'重置码无效或已过期，请联系管理员重新发放',
  PASSWORD_RESET_REQUIRED:'请先完成密码重置，再重新申请维护权限',
  MAINTAINER_REVOKED:'维护者权限已撤销，请联系管理员',
  ALREADY_MAINTAINER:'已获得所选题库的维护权限，正在刷新授权',
  BANK_NAME_MISMATCH:'题库名称与云端目录不一致，请联系题库维护者',
  UPLOAD_DISABLED:'上传服务暂未开放，本地题目仍然保留',
  RATE_LIMITED:'操作较频繁，请稍后重试',
  BATCH_CONFLICT:'云端已有此批次的不同内容，请联系维护者核对；本地题目已保留',
  PACKAGE_INVALID:'上传包校验失败，本地批次已保留，请联系维护者',
  QUESTION_INVALID:'题目或模型来源不符合上传要求，请核对录入内容',
  SEED_REQUIRED:'云端题库尚未初始化，请先由桌面端创建正式首版',
  ANSWER_CONFLICT:'上传题目与正式题库答案冲突，未合并本批次',
  MERGE_UNAVAILABLE:'云端已收到本批次，但合并尚未完成，请重试原批次',
  REVISION_CONFLICT:'题库刚刚更新，请重试原批次',
  STORAGE_UNAVAILABLE:'云端保存未确认，请重试本批次，不要重新录入',
  ORIGIN_DENIED:'当前请求来源尚未配置，请联系维护者',
};

// Tokens stay in the service closure, never in Page.data, storage, exports or logs.
export function createCloudClient(deps:{origin:()=>string;login:()=>Promise<string>;request:Transport;now?:()=>number}){
  let session:Session|undefined, pending:Promise<CloudAccess>|undefined, generation=0;
  const now=deps.now||Date.now;
  function origin(){const value=deps.origin();
    const match=/^https:\/\/[a-z0-9.-]+(?::([0-9]{1,5}))?$/i.exec(value);
    if(!match||(match[1]&&(Number(match[1])<1||Number(match[1])>65535)))throw new Error('云端 HTTPS 地址尚未配置，请联系管理员；本地录题仍可使用');
    return value;}
  function active(){if(session&&(session.expiresAt<=now()+15000||session.origin!==deps.origin()))session=undefined;return session;}
  function state():CloudAccess {const current=active();return {openid:current?.openid,username:current?.username,authType:current?.authType,status:current?.status,configured:!!deps.origin(),loggedIn:!!current,
    banks:current?current.banks.map(b=>({...b})):[],uploadsEnabled:current?.uploadsEnabled||false};}
  function logout(){generation++;session=undefined;pending=undefined;}
  async function call(path:string,method:'GET'|'POST',body:unknown,current?:Session):Promise<Response>{
    const response=await deps.request(current?.origin||origin(),path,method,body,current?.token);
    if(response.status<200||response.status>=300){
      const error=object(object(response.body).error),code=typeof error.code==='string'?error.code:'';
      if(response.status===401||code==='BANK_FORBIDDEN'||code==='MAINTAINER_REVOKED')logout();
      throw new UploadError(response.status===401?'登录已失效，请重新登录后重试':messages[code]||'云端请求未完成，请保留本地批次后重试',response.status,code);
    }
    return response;
  }
  async function startLogin(path:string,body:unknown|((code:string)=>unknown),allowPending=false):Promise<CloudAccess>{
    if(pending)return pending;
    const run=(async()=>{
      const base=origin(),epoch=generation,started=now();session=undefined;
      const code=await deps.login();
      if(!/^[A-Za-z0-9_-]{8,256}$/.test(code))throw new Error('未取得微信登录凭证，请重试');
      const result=object((await call(path,'POST',typeof body==='function'?(body as (code:string)=>unknown)(code):body)).body);
      if(typeof result.access_token!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.access_token)
        ||result.access_token.length>4096||!Number.isInteger(result.expires_in)||Number(result.expires_in)<30||Number(result.expires_in)>900)
        throw new Error('云端登录响应无效，请重试');
      const current:Session={openid:result.openid as string,token:result.access_token,origin:base,expiresAt:started+Number(result.expires_in)*1000,banks:readBanks(result.banks),uploadsEnabled:false,status:typeof result.status==='string'?result.status:undefined,phone:typeof result.phone==='string'?result.phone:undefined,nickname:typeof result.nickname==='string'?result.nickname:undefined,authType:'wechat'};
      const me=object((await call('/v1/me','GET',undefined,current)).body);
      if(typeof result.openid!=='string'||me.openid!==result.openid||!Array.isArray(me.permissions)||(!allowPending&&!me.permissions.includes('upload'))||typeof me.uploads_enabled!=='boolean')
        throw new Error('云端身份或权限校验失败，请重新登录');
      current.banks=readBanks(me.banks);current.uploadsEnabled=me.uploads_enabled;
      if(epoch!==generation||base!==deps.origin())throw new Error('登录已取消，请重新登录');
      session=current;return state();
    })();
    pending=run;void run.finally(()=>{if(pending===run)pending=undefined;}).catch(()=>{});return run;
  }
  async function loginWechat():Promise<CloudAccess>{
    return startLogin('/v1/auth/wechat-login',(loginCode:string)=>({login_code:loginCode}),true);
  }
  async function loginPassword(username:string,password:string):Promise<CloudAccess>{
    if(pending)return pending;
    const run=(async()=>{
      const base=origin(),epoch=generation,started=now();session=undefined;
      const result=object((await call('/v1/auth/password-login','POST',{username,password})).body);
      if(typeof result.access_token!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.access_token)
        ||result.access_token.length>4096||!Number.isInteger(result.expires_in)||Number(result.expires_in)<30||Number(result.expires_in)>900)
        throw new Error('账号登录响应无效，请重试');
      const current:Session={openid:result.openid as string,username:typeof result.username==='string'?result.username:username.trim().toLowerCase(),authType:'password',token:result.access_token,origin:base,
        expiresAt:started+Number(result.expires_in)*1000,banks:readBanks(result.banks),uploadsEnabled:false,status:typeof result.status==='string'?result.status:undefined,phone:typeof result.phone==='string'?result.phone:undefined};
      const me=object((await call('/v1/me','GET',undefined,current)).body);
      if(typeof result.openid!=='string'||me.openid!==result.openid||!Array.isArray(me.permissions)||typeof me.uploads_enabled!=='boolean')throw new Error('云端身份或权限校验失败，请重新登录');
      current.banks=readBanks(me.banks);current.uploadsEnabled=me.uploads_enabled;current.status=typeof me.account_status==='string'?me.account_status:current.status;
      if(epoch!==generation||base!==deps.origin())throw new Error('登录已取消，请重新登录');
      session=current;return state();
    })();
    pending=run;void run.finally(()=>{if(pending===run)pending=undefined;}).catch(()=>{});return run;
  }
  async function registerMaintainer(bankId:string,form:MaintainerRegistrationForm){
    const fields=registrationFields(form);
    const result=object((await call('/v1/auth/register','POST',{...fields,bank_ids:[bankId]})).body);
    if(!result.account||!result.application)throw new Error('注册响应无效，请稍后重试');
    return result.application as {id:string;status:string;phone:string;real_name:string;nickname:string;identity_description:string;bank_ids:string[]};
  }
  async function resetMaintainerPassword(username:string,resetToken:string,password:string,passwordConfirm:string){
    const normalized=username.trim().toLowerCase();
    if(!/^[a-z0-9][a-z0-9._-]{2,30}[a-z0-9]$/.test(normalized))throw new Error('账号需为 4 至 32 位字母、数字、点、下划线或连字符');
    if(typeof resetToken!=='string'||resetToken.trim().length<32||resetToken.trim().length>128)throw new Error('请填写管理员提供的一次性重置码');
    if(!passwordMeetsPolicy(password))throw new Error('密码至少 8 位，且需包含大写字母、小写字母和数字');
    if(password!==passwordConfirm)throw new Error('两次输入的新密码不一致');
    const result=object((await call('/v1/auth/password-reset','POST',{username:normalized,reset_token:resetToken.trim(),password})).body);
    if(result.status!=='pending'||result.username!==normalized)throw new Error('密码重置响应无效，请联系管理员');
    return result as {username:string;status:'pending'};
  }
  async function applyMaintainer(bankId:string,form?:MaintainerForm){
    let current=active();
    if(!current?.authType){
      const fields=applicationFields(form||{phone:'',realName:'',nickname:'',identity:''});
      await loginWechat();current=active();
      if(!current)throw new Error('微信登录已失效，请重试');
      return submitApplication(bankId,{bank_ids:[bankId],...fields},current);
    }
    return submitApplication(bankId,{bank_ids:[bankId],...(current.authType==='wechat'?applicationFields(form||{phone:'',realName:'',nickname:'',identity:''}):{})},current);
  }
  async function submitApplication(bankId:string,body:Record<string,unknown>,current:Session){
    if(active()!==current)throw new Error('登录已失效，请重试');
    let result:Record<string,unknown>;
    try { result=object((await call('/v1/maintainer-applications','POST',body,current)).body); }
    catch(error){
      if(error instanceof UploadError && error.code==='ALREADY_MAINTAINER'&&current.banks.some(bank=>bank.bank_id===bankId))
        return {id:'',status:'approved',bank_ids:[bankId]};
      throw error;
    }
    if(!result.application)throw new Error('申请响应无效');
    return result.application as {id:string;status:string;phone:string;real_name:string;nickname:string;identity_description:string;bank_ids:string[]};
  }
  async function authorize(bankId:string,name:string){
    const current=active();if(!current)throw new UploadError('请先登录维护者账号',403,'LOGIN_REQUIRED');
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
  async function upload(expected:ReturnType<typeof prepareUpload>,expectedOrigin:string){
    const current=active();if(!current||current.origin!==expectedOrigin)throw new Error('登录已失效或服务地址改变，请重新登录后重试');
    const response=await call('/v1/uploads','POST',{format:'qbank-confirmed-upload-1',package:expected.envelope},current),body=object(response.body);
    if(!((response.status===201&&body.duplicate===false)||(response.status===200&&body.duplicate===true)))throw new Error('云端上传响应无效，请重试本批次');
    return {receipt:verifyReceipt(body.receipt,expected),duplicate:body.duplicate as boolean};
  }
  async function health(){return object((await call('/health','GET',undefined)).body)}
  return {state,loginWechat,loginPassword,registerMaintainer,resetMaintainerPassword,applyMaintainer,logout,authorize,upload,health};
}

const request:Transport=(origin,path,method,body,token)=>new Promise((resolve,reject)=>{
  wx.request({url:origin+path,method,data:body===undefined?undefined:JSON.stringify(body),dataType:'json',responseType:'text',timeout:20000,
    header:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
    success:r=>{try{const text=typeof r.data==='string'?r.data:JSON.stringify(r.data);
      if(!text||text.length>65536)throw new Error('云端响应无效');
      resolve({status:r.statusCode,body:JSON.parse(text)});}catch{reject(new Error('云端响应无法识别，请保留本地批次后重试'));}},
    fail:e=>reject(new UploadError(/url not in domain|不在.*合法域名|domain list/i.test(e.errMsg)?'上传域名尚未加入小程序合法域名，请联系维护者配置':'网络请求未完成，稍后自动重试',0,/url not in domain|不在.*合法域名|domain list/i.test(e.errMsg)?'DOMAIN_CONFIGURATION':'NETWORK'))});
});
export const cloud=createCloudClient({origin:authOrigin,request,login:()=>new Promise((resolve,reject)=>wx.login({timeout:10000,
  success:r=>r.code?resolve(r.code):reject(new Error('微信登录失败，请重试')),fail:()=>reject(new Error('微信登录失败，请确认网络后重试'))}))});
