import {UploadError} from '../core/queue';
import {authOrigin} from '../config/cloud';
import {prepareUpload,verifyReceipt} from '../core/upload';
import {passwordMeetsPolicy,registrationFields,type MaintainerForm,type MaintainerRegistrationForm} from './maintainer-application';

type Bank={bank_id:string;name:string};
type Session={openid:string;token:string;refreshToken:string;origin:string;expiresAt:number;banks:Bank[];permissions:string[];pendingPermissions:string[];uploadsEnabled:boolean;status?:string;phone?:string;nickname?:string;authType:'password'};
type Response={status:number;body:unknown};
type Transport=(origin:string,path:string,method:'GET'|'POST',body:unknown,token?:string)=>Promise<Response>;
export type CloudAccess={openid?:string;phone?:string;authType?:'password';status?:string;configured:boolean;loggedIn:boolean;banks:Bank[];permissions:string[];pendingPermissions:string[];uploadsEnabled:boolean};
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
  LOGIN_REQUIRED:'请先使用手机号和密码登录',
  PHONE_INVALID:'请填写有效的 11 位手机号',
  REAL_NAME_REQUIRED:'请填写 1 至 40 字的真实姓名',
  NICKNAME_INVALID:'请填写昵称，用于记录题目上传者（最多 80 字）',
  PHONE_IN_USE:'此手机号已登记，请直接登录或联系管理员核实',
  PHONE_CHANGE_REQUIRES_ADMIN:'已授权账号修改手机号需联系管理员核实',
  BANKS_REQUIRED:'请选择有效的云端题库；私人本地题库不能申请云端权限',
  PERMISSIONS_INVALID:'权限申请无效，请刷新客户端后重试',
  APPLICATION_EMPTY:'请至少申请一个题库维护权限或 Word 导出权限',
  ALREADY_PERMISSION:'已经获得或正在申请所选权限',
  IDENTITY_REQUIRED:'请填写 1 至 500 字的身份说明，方便管理员核实',
  PASSWORD_INVALID:'密码至少 8 位，且需包含大写字母、小写字母和数字',
  CREDENTIALS_INVALID:'手机号或密码不正确',
  SESSION_INVALID:'登录已失效，请使用手机号和密码重新登录',
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
const SESSION_STORAGE_PREFIX='qbank-maintainer-refresh-v1:';
const PHONE_PATTERN=/^1[3-9]\d{9}$/;
function refreshStorageKey(origin:string){return SESSION_STORAGE_PREFIX+origin;}
function normalizePhone(value:string){return value.trim().replace(/[\s()-]/g,'').replace(/^(?:\+86|0086)/,'');}

// Access tokens stay in memory. Only a revocable refresh token is kept in the
// Mini Program's private storage so the session survives app restarts.
export function createCloudClient(deps:{origin:()=>string;request:Transport;now?:()=>number}){
  let session:Session|undefined, pending:Promise<CloudAccess>|undefined, restoring:Promise<CloudAccess>|undefined, refreshing:Promise<Session>|undefined, generation=0;
  const now=deps.now||Date.now;
  function origin(){const value=deps.origin();
    const match=/^https:\/\/[a-z0-9.-]+(?::([0-9]{1,5}))?$/i.exec(value);
    if(!match||(match[1]&&(Number(match[1])<1||Number(match[1])>65535)))throw new Error('云端 HTTPS 地址尚未配置，请联系管理员；本地录题仍可使用');
    return value;
  }
  function active(){if(session&&session.origin!==deps.origin())session=undefined;return session;}
  function state():CloudAccess {const current=active();return {openid:current?.openid,phone:current?.phone,authType:current?.authType,status:current?.status,configured:!!deps.origin(),loggedIn:!!current,
    banks:current?current.banks.map(b=>({...b})):[],permissions:current?[...current.permissions]:[],pendingPermissions:current?[...current.pendingPermissions]:[],uploadsEnabled:current?.uploadsEnabled||false};}
  function clear(current=session,removeStored=true){generation++;if(!current||session===current)session=undefined;pending=undefined;refreshing=undefined;
    if(removeStored&&current?.origin)try{wx.removeStorageSync(refreshStorageKey(current.origin));}catch{/* Keep offline search available if local storage is unavailable. */}
  }
  function responseError(response:Response,current?:Session):never{
    const error=object(object(response.body).error),code=typeof error.code==='string'?error.code:'';
    if(current&&(response.status===401||code==='MAINTAINER_REVOKED'))clear(current,true);
    throw new UploadError(response.status===401?'登录已失效，请重新登录后重试':messages[code]||'云端请求未完成，请保留本地批次后重试',response.status,code);
  }
  async function rawCall(path:string,method:'GET'|'POST',body:unknown,current?:Session):Promise<Response>{
    const response=await deps.request(current?.origin||origin(),path,method,body,current?.token);
    if(response.status<200||response.status>=300)responseError(response,current);
    return response;
  }
  function saveRefreshToken(base:string,token:string){
    try{wx.setStorageSync(refreshStorageKey(base),token);}
    catch{throw new Error('无法在小程序本机保存登录状态，请清理存储空间后重试');}
  }
  function readRefreshToken(base:string){
    try{const token=wx.getStorageSync(refreshStorageKey(base));return typeof token==='string'?token:'';}
    catch{return '';}
  }
  function removeRefreshToken(base:string){try{wx.removeStorageSync(refreshStorageKey(base));}catch{/* No local credential remains accessible to this session. */}}
  function applyAccess(current:Session,me:Record<string,unknown>){
    if(typeof me.openid!=='string'||me.openid!==current.openid||!Array.isArray(me.permissions)||typeof me.uploads_enabled!=='boolean')throw new Error('云端身份或权限校验失败，请重新登录');
    if(me.permissions.some(permission=>typeof permission!=='string')||me.pending_permissions!==undefined&&(!Array.isArray(me.pending_permissions)||me.pending_permissions.some(permission=>typeof permission!=='string')))throw new Error('云端权限响应无效，请重新登录');
    current.banks=readBanks(me.banks);current.permissions=[...new Set(me.permissions as string[])];current.pendingPermissions=[...new Set((me.pending_permissions||[]) as string[])];current.uploadsEnabled=me.uploads_enabled;
    current.status=typeof me.account_status==='string'?me.account_status:current.status;
    current.phone=typeof me.phone==='string'?me.phone:current.phone;
  }
  async function refreshSession(current:Session):Promise<Session>{
    if(current.expiresAt>now()+15000)return current;
    if(refreshing)return refreshing;
    const epoch=generation;
    const run=(async()=>{
      const response=await deps.request(current.origin,'/v1/auth/refresh','POST',{refresh_token:current.refreshToken});
      if(response.status<200||response.status>=300)responseError(response,current);
      const result=object(response.body);
      if(typeof result.access_token!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.access_token)
        ||!Number.isInteger(result.expires_in)||Number(result.expires_in)<30||Number(result.expires_in)>900)
        throw new Error('云端登录续期响应无效，请重新登录');
      if(epoch!==generation||session!==current||current.origin!==deps.origin())throw new Error('登录状态已改变，请重试');
      current.token=result.access_token;current.expiresAt=now()+Number(result.expires_in)*1000;
      if(typeof result.refresh_token==='string'&&/^r1\.[A-Za-z0-9_-]{43}$/.test(result.refresh_token)){
        current.refreshToken=result.refresh_token;saveRefreshToken(current.origin,current.refreshToken);
      }
      const me=object((await rawCall('/v1/me','GET',undefined,current)).body);applyAccess(current,me);
      return current;
    })();
    refreshing=run;void run.finally(()=>{if(refreshing===run)refreshing=undefined}).catch(()=>{});return run;
  }
  async function call(path:string,method:'GET'|'POST',body:unknown,current?:Session):Promise<Response>{
    let usable=current;
    if(usable&&path!=='/v1/auth/refresh'&&path!=='/v1/auth/logout'&&usable.expiresAt<=now()+15000)usable=await refreshSession(usable);
    return rawCall(path,method,body,usable);
  }
  async function restoreSession():Promise<CloudAccess>{
    const current=active();
    if(current){if(current.expiresAt<=now()+15000)await refreshSession(current);return state();}
    if(restoring)return restoring;
    const epoch=generation;
    const run=(async()=>{
      const base=origin(),token=readRefreshToken(base);
      if(!token)return state();
      if(!/^r1\.[A-Za-z0-9_-]{43}$/.test(token)){removeRefreshToken(base);return state();}
      const response=await deps.request(base,'/v1/auth/refresh','POST',{refresh_token:token});
      if(response.status===401||response.status===403){removeRefreshToken(base);return state();}
      if(response.status<200||response.status>=300)return responseError(response);
      const result=object(response.body);
      if(typeof result.access_token!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.access_token)
        ||!Number.isInteger(result.expires_in)||Number(result.expires_in)<30||Number(result.expires_in)>900)
        throw new Error('云端登录续期响应无效');
      const nextToken=typeof result.refresh_token==='string'&&/^r1\.[A-Za-z0-9_-]{43}$/.test(result.refresh_token)?result.refresh_token:token;
      if(nextToken!==token)saveRefreshToken(base,nextToken);
      const current:Session={openid:typeof result.openid==='string'?result.openid:'',token:result.access_token,refreshToken:nextToken,origin:base,
        expiresAt:now()+Number(result.expires_in)*1000,banks:readBanks(result.banks),permissions:[],pendingPermissions:[],uploadsEnabled:false,status:typeof result.status==='string'?result.status:undefined,
        phone:typeof result.phone==='string'?result.phone:undefined,authType:'password'};
      const me=object((await rawCall('/v1/me','GET',undefined,current)).body);applyAccess(current,me);
      if(epoch!==generation||base!==deps.origin())throw new Error('登录状态已改变，请重试');
      session=current;return state();
    })();
    restoring=run;void run.finally(()=>{if(restoring===run)restoring=undefined}).catch(()=>{});return run;
  }
  async function logout(){
    const current=session,base=current?.origin||deps.origin(),token=current?.refreshToken||readRefreshToken(base);
    clear(current,false);
    try{if(token)await deps.request(base,'/v1/auth/logout','POST',{refresh_token:token});}
    catch{/* Local logout must still work when the device is offline. */}
    removeRefreshToken(base);
  }
  async function loginPassword(phone:string,password:string):Promise<CloudAccess>{
    if(pending)return pending;
    const run=(async()=>{
      const base=origin(),epoch=++generation,started=now();session=undefined;
      const normalized=normalizePhone(phone);if(!PHONE_PATTERN.test(normalized))throw new Error('请填写有效的 11 位手机号');
      const result=object((await rawCall('/v1/auth/password-login','POST',{phone:normalized,password,client:'miniprogram'})).body);
      if(typeof result.access_token!=='string'||!/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.access_token)
        ||typeof result.refresh_token!=='string'||!/^r1\.[A-Za-z0-9_-]{43}$/.test(result.refresh_token)
        ||!Number.isInteger(result.expires_in)||Number(result.expires_in)<30||Number(result.expires_in)>900)
        throw new Error('云端登录响应无效，请重试');
      saveRefreshToken(base,result.refresh_token);
      try{
        const current:Session={openid:typeof result.openid==='string'?result.openid:'',token:result.access_token,refreshToken:result.refresh_token,origin:base,
          expiresAt:started+Number(result.expires_in)*1000,banks:readBanks(result.banks),permissions:[],pendingPermissions:[],uploadsEnabled:false,status:typeof result.status==='string'?result.status:undefined,
          phone:typeof result.phone==='string'?result.phone:undefined,authType:'password'};
        const me=object((await rawCall('/v1/me','GET',undefined,current)).body);applyAccess(current,me);
        if(epoch!==generation||base!==deps.origin())throw new Error('登录已取消，请重新登录');
        session=current;return state();
      }catch(error){
        // Do not let a failed validation resurrect a half-open session later.
        // A newer login may already have replaced this token, so only remove
        // the token that this attempt wrote.
        if(epoch===generation&&readRefreshToken(base)===result.refresh_token)removeRefreshToken(base);
        throw error;
      }
    })();
    pending=run;void run.finally(()=>{if(pending===run)pending=undefined}).catch(()=>{});return run;
  }
  async function registerMaintainer(bankIds:string|string[],form:MaintainerRegistrationForm,permissions:string[]=[]){
    const fields=registrationFields(form);
    const selectedBankIds=[...new Set(Array.isArray(bankIds)?bankIds:[bankIds])];
    const requested=[...new Set(permissions)];
    if(!selectedBankIds.length&&!requested.length)throw new Error('至少申请一个题库维护权限或 Word 导出权限');
    if(requested.some(permission=>permission!=='export'))throw new Error(messages.PERMISSIONS_INVALID);
    const result=object((await call('/v1/auth/register','POST',{...fields,bank_ids:selectedBankIds,permissions:requested})).body);
    if(!result.account||!result.application)throw new Error('注册响应无效，请稍后重试');
    return result.application as {id:string;status:string;phone:string;real_name:string;nickname:string;identity_description:string;bank_ids:string[]};
  }
  async function resetMaintainerPassword(phone:string,resetToken:string,password:string,passwordConfirm:string){
    const normalized=normalizePhone(phone);
    if(!PHONE_PATTERN.test(normalized))throw new Error('请填写有效的 11 位手机号');
    if(typeof resetToken!=='string'||resetToken.trim().length<32||resetToken.trim().length>128)throw new Error('请填写管理员提供的一次性重置码');
    if(!passwordMeetsPolicy(password))throw new Error('密码至少 8 位，且需包含大写字母、小写字母和数字');
    if(password!==passwordConfirm)throw new Error('两次输入的新密码不一致');
    const result=object((await call('/v1/auth/password-reset','POST',{phone:normalized,reset_token:resetToken.trim(),password})).body);
    if(result.status!=='pending')throw new Error('密码重置响应无效，请联系管理员');
    return result as {phone:string;status:'pending'};
  }
  async function applyMaintainer(bankId:string,_form?:MaintainerForm){
    const current=active();if(!current)throw new UploadError('请先使用手机号和密码登录',403,'LOGIN_REQUIRED');
    return submitApplication(bankId,{bank_ids:[bankId]},current);
  }
  async function applyPermissions(permissions:string[]){
    const current=active();if(!current)throw new UploadError('请先使用手机号和密码登录',403,'LOGIN_REQUIRED');
    const requested=[...new Set(permissions)];if(!requested.length||requested.some(permission=>permission!=='export'))throw new UploadError(messages.PERMISSIONS_INVALID,422,'PERMISSIONS_INVALID');
    const result=await submitApplication(undefined,{bank_ids:[],permissions:requested},current);
    const me=object((await call('/v1/me','GET',undefined,current)).body);applyAccess(current,me);
    return result;
  }
  async function submitApplication(bankId:string|undefined,body:Record<string,unknown>,current:Session){
    if(active()!==current)throw new Error('登录已失效，请重试');
    let result:Record<string,unknown>;
    try { result=object((await call('/v1/maintainer-applications','POST',body,current)).body); }
    catch(error){
      if(error instanceof UploadError&&error.code==='ALREADY_MAINTAINER'&&bankId&&current.banks.some(bank=>bank.bank_id===bankId))return {id:'',status:'approved',bank_ids:[bankId]};
      throw error;
    }
    if(!result.application)throw new Error('申请响应无效');
    return result.application as {id:string;status:string;phone:string;real_name:string;nickname:string;identity_description:string;bank_ids:string[]};
  }
  async function authorize(bankId:string,name:string){
    const current=active();if(!current)throw new UploadError('请先使用手机号和密码登录',403,'LOGIN_REQUIRED');
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
  return {state,restoreSession,loginPassword,registerMaintainer,resetMaintainerPassword,applyMaintainer,applyPermissions,logout,authorize,upload,health};
}

const request:Transport=(origin,path,method,body,token)=>new Promise((resolve,reject)=>{
  wx.request({url:origin+path,method,data:body===undefined?undefined:JSON.stringify(body),dataType:'json',responseType:'text',timeout:20000,
    header:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
    success:r=>{try{const text=typeof r.data==='string'?r.data:JSON.stringify(r.data);
      if(!text||text.length>65536)throw new Error('云端响应无效');
      resolve({status:r.statusCode,body:JSON.parse(text)});}catch{reject(new Error('云端响应无法识别，请保留本地批次后重试'));}},
    fail:e=>reject(new UploadError(/url not in domain|不在.*合法域名|domain list/i.test(e.errMsg)?'上传域名尚未加入小程序合法域名，请联系维护者配置':'网络请求未完成，稍后自动重试',0,/url not in domain|不在.*合法域名|domain list/i.test(e.errMsg)?'DOMAIN_CONFIGURATION':'NETWORK'))});
});
export const cloud=createCloudClient({origin:authOrigin,request});
