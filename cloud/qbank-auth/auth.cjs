'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {VERSION,LIMITS,UUID,HASH,SUBJECT,sha256,object,HttpError,fail,exact}=require('./common.cjs');
function sign(payload, config) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(config.sessionSecret, 'hex'))
    .update(`qbank-session-v1.${encoded}`).digest('base64url');
  return `v1.${encoded}.${signature}`;
}
function verify(token, config, now, registry) {
  if (typeof token !== 'string' || token.length > 2048) fail(401, 'LOGIN_REQUIRED', '请先进行开发者登录');
  const parts = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) fail(401, 'SESSION_INVALID', '登录已失效，请重新登录');
  const expected = createHmac('sha256', Buffer.from(config.sessionSecret, 'hex'))
    .update(`qbank-session-v1.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    fail(401, 'SESSION_INVALID', '登录已失效，请重新登录');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { fail(401, 'SESSION_INVALID', '登录已失效，请重新登录'); }
  if (!object(payload) || !SUBJECT.test(payload.sub) || !['qbank-desktop-v1','qbank-maintainer-account-v1'].includes(payload.aud)
    || payload.app_id !== config.appId || payload.auth_version !== config.authVersion
    || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
    || payload.exp <= now || payload.iat > now + 30 || payload.exp - payload.iat !== LIMITS.sessionSeconds)
    fail(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
  if(payload.aud === 'qbank-desktop-v1') {
    const maintainer=config.maintainers.find(m=>`d_${m.id}`===payload.sub && m.key_sha256===payload.key_version);
    if(!maintainer)fail(403,'MAINTAINER_REVOKED','维护者授权已撤销，请联系管理员');
    return {openid:payload.sub,banks:Object.keys(maintainer.grants),grants:maintainer.grants,desktop:true,
      capabilities:config.creators.includes(maintainer.id)?['cloud_bank:create','maintainer:manage']:[] ,maintainer_id:maintainer.id,
      real_name:maintainer.real_name||maintainer.id,nickname:maintainer.nickname||''};
  }
  if(payload.aud==='qbank-maintainer-account-v1'){
    const accountId=payload.sub.slice(2),account=(registry?.password_accounts||[]).find(a=>a.id===accountId);
    if(!account||account.status==='revoked'||account.status==='password_reset_required')fail(403,'MAINTAINER_REVOKED','维护者账号已撤销或需要重置，请重新登录');
    if(payload.password_version!==sha256(account.password_hash))fail(401,'SESSION_INVALID','登录已失效，请重新登录');
    const approved=account.status==='approved',grants=approved&&object(account.grants)?account.grants:{};
    return {openid:payload.sub,banks:Object.keys(grants),grants,desktop:false,password_account:true,
      account_id:account.id,phone_masked:account.phone_masked||'',
      nickname:account.nickname||'',real_name:account.real_name||'',account_status:account.status||'pending',
      permissions:approved&&Array.isArray(account.permissions)?account.permissions.filter(permission=>permission==='export'):[]};
  }
}

module.exports={sign,verify};
