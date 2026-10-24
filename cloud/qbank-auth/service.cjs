'use strict';
const {timingSafeEqual,randomUUID}=require('node:crypto');
const {VERSION,LIMITS,UUID,HASH,sha256,object,HttpError,fail,exact}=require('./common.cjs');
const {loadConfig,authChecks,authConfigured,requireAuthConfig}=require('./config.cjs');
const {sign,verify}=require('./auth.cjs');
const {decodeUpload,jsonBody,receipt}=require('./submission.cjs');
const {createAccessRegistry,validateWechatIdentity}=require('./access.cjs');

function createHandler({ env = () => process.env, store, exchangeWechat, parseDelta, parseModelReply, validateStandardQuestion, clock = Date.now }) {
  const workflow = require('./workflow.cjs').createWorkflow({store,validateStandardQuestion,clock});
  const access = createAccessRegistry({store,clock});
  const rate = new Map();
  function throttle(key, maximum) {
    const minute = Math.floor(clock() / 60000);
    for (const [k, v] of rate) if (v.minute !== minute) rate.delete(k);
    if (!rate.has(key) && rate.size >= 1000) fail(429, 'RATE_LIMITED', '请求较多，请稍后重试');
    const count = (rate.get(key)?.count || 0) + 1;
    rate.set(key, { minute, count });
    if (count > maximum) fail(429, 'RATE_LIMITED', '请求较多，请稍后重试');
  }
  return async function mainHandler(event) {
    const responseHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff' };
    const respond = (statusCode, value) => ({ statusCode, headers: responseHeaders, body: JSON.stringify(value) });
    try {
      const config = await workflow.resolve(loadConfig(env()));
      const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      if (headers.origin) {
        if (!config.origins.includes(headers.origin)) fail(403, 'ORIGIN_DENIED', '此来源未获允许');
        responseHeaders['access-control-allow-origin'] = headers.origin;
        responseHeaders.vary = 'Origin';
      }
      const method = event.httpMethod, path = event.path;
      if (method === 'OPTIONS') {
        responseHeaders['access-control-allow-methods'] = 'GET, POST, OPTIONS';
        responseHeaders['access-control-allow-headers'] = 'content-type, authorization';
        return respond(204, null);
      }
      if (method === 'GET' && path === '/health') return respond(200, {
        service: 'qbank-auth', version: VERSION, auth_configured: authConfigured(config),
        auth_checks: authChecks(config),
        uploads_enabled: config.uploadsEnabled, sync_enabled: config.syncEnabled, capabilities:['confirmed-upload-v1','snapshot-v2','cloud-file-gzip-base64-v1','recorded-at-v1','merge-v1','cloud-bank-promotion-v1','session-upload-v1','wechat-manual-application-v1','maintainer-approval-v1','certificate-import-v1'], limits: LIMITS,
      });
      const publicResult = await workflow.read(method,path,config);
      if(publicResult !== undefined)return respond(200,publicResult);
      const workflowRoute = /^\/v1\/banks\/[0-9a-f-]{36}\/(seed|history|rollback)$/.test(path||'');
      const maintainerRoute = method==='GET' && ['/v1/maintainer-applications','/v1/maintainer-accounts'].includes(path)
        || method==='POST' && (path==='/v1/maintainer-applications' || /^\/v1\/maintainer-applications\/[0-9a-f-]{36}\/decision$/.test(path) || /^\/v1\/maintainer-accounts\/[0-9a-f-]{36}\/revoke$/.test(path));
      if (!workflowRoute && !maintainerRoute && !['POST /v1/auth/desktop', 'POST /v1/auth/wechat-login', 'GET /v1/me', 'POST /v1/uploads', 'POST /v1/banks/promote'].includes(`${method} ${path}`))
        fail(404, 'NOT_FOUND', '接口不存在');
      requireAuthConfig(config);
      const now = Math.floor(clock() / 1000);
      if (method === 'POST' && headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
        fail(415, 'JSON_REQUIRED', '请使用 application/json');
      if (path === '/v1/auth/desktop') {
        throttle('login:all',100);throttle(`desktop:${String(headers['x-forwarded-for']||headers['x-client-address']||'unknown').slice(0,100)}`,10);
        const body=jsonBody(event,1024);
        if(!exact(body,['key']) || typeof body.key!=='string' || !HASH.test(body.key))fail(401,'KEY_INVALID','维护密钥无效');
        const digest=Buffer.from(sha256(body.key),'hex');
        const maintainer=config.maintainers.find(m=>timingSafeEqual(Buffer.from(m.key_sha256,'hex'),digest));
        if(!maintainer)fail(401,'KEY_INVALID','维护密钥无效或已撤销');
        return respond(200,{access_token:sign({sub:`d_${maintainer.id}`,aud:'qbank-desktop-v1',app_id:config.appId,
          auth_version:config.authVersion,key_version:maintainer.key_sha256,iat:now,exp:now+LIMITS.sessionSeconds},config),
          expires_in:LIMITS.sessionSeconds,banks:config.banks.filter(b=>Object.hasOwn(maintainer.grants,b.bank_id)),grants:maintainer.grants});
      }
      if(path==='/v1/auth/wechat-login'){
        throttle('login:all',100);throttle(`login:${String(headers['x-forwarded-for']||headers['x-client-address']||'unknown').slice(0,100)}`,10);
        const body=jsonBody(event,1024);
        if(!exact(body,['login_code'])||typeof body.login_code!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(body.login_code))
          fail(400,'CODE_REQUIRED','请提供微信登录凭证');
        let identity;
        try{
          if(typeof exchangeWechat!=='function')fail(503,'WECHAT_UNAVAILABLE','服务端尚未配置微信登录校验');
          identity=validateWechatIdentity(await exchangeWechat({appId:config.appId,appSecret:config.appSecret,loginCode:body.login_code}));
        }catch(error){if(error instanceof HttpError)throw error;fail(502,'WECHAT_UNAVAILABLE','微信登录校验暂不可用，请重试');}
        const registry=await access.read(),account=registry.wechat_accounts.find(a=>a.openid===identity.openid);
        if(account?.status==='revoked')fail(403,'MAINTAINER_REVOKED','维护者权限已撤销，请联系管理员');
        const token=sign({sub:identity.openid,aud:'qbank-wechat-v3',app_id:config.appId,auth_version:config.authVersion,iat:now,exp:now+LIMITS.sessionSeconds},config);
        const grants=account?.status==='approved'&&object(account.grants)?account.grants:{};
        return respond(200,{access_token:token,expires_in:LIMITS.sessionSeconds,openid:identity.openid,phone:account?.phone_masked||'',nickname:account?.nickname||'',status:account?.status||'pending',banks:config.banks.filter(b=>Object.hasOwn(grants,b.bank_id)),permissions:[...new Set(Object.values(grants).flat())]});
      }
      const auth = verify(typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
        ? headers.authorization.slice(7) : null, config, now, await access.read());
      if (path === '/v1/me') return respond(200, { openid: auth.openid, phone: auth.phone_masked||'', nickname:auth.nickname||'', account_status:auth.account_status|| (auth.desktop?'desktop':'approved'),
        banks: config.banks.filter(b => auth.banks.includes(b.bank_id)), permissions: [...new Set(Object.values(auth.grants).flat())], grants:auth.grants, capabilities:auth.capabilities||[], uploads_enabled: config.uploadsEnabled });
      const isAdmin=auth.desktop&&auth.capabilities?.includes('wechat:manage');
      if(path==='/v1/maintainer-applications'&&method==='GET'){
        if(!isAdmin)fail(403,'ROLE_FORBIDDEN','只有桌面最高权限可以管理维护者申请');
        const registry=await access.read();
        return respond(200,{applications:registry.maintainer_applications.filter(a=>a.status==='pending').map(a=>({id:a.id,phone:a.phone,real_name:a.real_name,phone_source:a.phone_source,nickname:a.nickname,identity_description:a.identity_description,bank_ids:a.bank_ids,created_at:a.created_at,status:a.status}))});
      }
      if(path==='/v1/maintainer-accounts'&&method==='GET'){
        if(!isAdmin)fail(403,'ROLE_FORBIDDEN','只有桌面最高权限可以管理维护者账号');
        const registry=await access.read();
        return respond(200,{accounts:registry.wechat_accounts.map(a=>({id:a.id,phone:a.phone,real_name:a.real_name,phone_source:a.phone_source,nickname:a.nickname,identity_description:a.identity_description,openid:a.openid,grants:a.grants,status:a.status,created_at:a.created_at,approved_at:a.approved_at||null,revoked_at:a.revoked_at||null}))});
      }
      if(path==='/v1/maintainer-applications'&&method==='POST'){
        if(!auth.wechat)fail(403,'WECHAT_LOGIN_REQUIRED','请在小程序登录微信后提交申请');
        const body=jsonBody(event,8192);if(!Array.isArray(body?.bank_ids)||!body.bank_ids.length||body.bank_ids.length>100||body.bank_ids.some(id=>!UUID.test(id)))fail(422,'BANKS_REQUIRED','请选择要维护的题库');
        const phone=access.normalizePhone(body.phone),phoneHash=access.phoneHash(phone);
        const realName=typeof body.real_name==='string'?body.real_name.trim():'';
        if(!realName||realName.length>40)fail(422,'REAL_NAME_REQUIRED','请填写 1 至 40 字的真实姓名');
        if(body.nickname!==undefined&&(typeof body.nickname!=='string'||body.nickname.length>80))fail(422,'NICKNAME_INVALID','昵称最多 80 字');
        const nickname=(body.nickname||'').trim();
        const identityDescription=typeof body.identity_description==='string'?body.identity_description.trim():'';
        if(!identityDescription||identityDescription.length>500)fail(422,'IDENTITY_REQUIRED','请填写 1 至 500 字的身份说明，方便管理员核实');
        const validBanks=[...new Set(body.bank_ids)];if(validBanks.some(id=>!config.banks.some(b=>b.bank_id===id)))fail(422,'BANKS_REQUIRED','请选择有效的云端题库');
        let applicationId,created=false;
        const result=await access.update(registry=>{
          const phoneOwner=registry.wechat_accounts.find(a=>a.phone_hash===phoneHash&&a.status==='approved');
          if(phoneOwner&&phoneOwner.openid!==auth.openid)fail(409,'PHONE_IN_USE','此手机号已绑定其他微信账号，请联系管理员核实');
          const existing=registry.wechat_accounts.find(a=>a.openid===auth.openid&&a.status==='approved');
          if(existing&&existing.phone_hash!==phoneHash)fail(409,'PHONE_CHANGE_REQUIRES_ADMIN','已授权账号修改手机号需联系管理员核实');
          const requested=validBanks.filter(id=>!existing?.grants?.[id]?.includes('upload'));
          if(!requested.length)fail(409,'ALREADY_MAINTAINER','已经获得所选题库的维护权限');
          const pending=registry.maintainer_applications.find(a=>a.openid===auth.openid&&a.status==='pending');
          const details={phone,phone_hash:phoneHash,phone_masked:access.maskPhone(phone),phone_source:'self_reported',real_name:realName,nickname,identity_description:identityDescription};
          if(pending){Object.assign(pending,details,{bank_ids:[...new Set([...pending.bank_ids,...requested])],updated_at:new Date(clock()).toISOString()});applicationId=pending.id;created=false;}
          else {applicationId=randomUUID();created=true;registry.maintainer_applications.push({id:applicationId,...details,openid:auth.openid,bank_ids:requested,status:'pending',created_at:new Date(clock()).toISOString()});}
        });
        const application=result.maintainer_applications.find(a=>a.id===applicationId);
        return respond(created?201:200,{application:{id:application.id,status:application.status,phone:application.phone_masked,real_name:application.real_name,nickname:application.nickname,identity_description:application.identity_description,bank_ids:application.bank_ids}});
      }
      const decisionMatch=/^\/v1\/maintainer-applications\/([0-9a-f-]{36})\/decision$/.exec(path||'');
      if(decisionMatch&&method==='POST'){
        if(!isAdmin)fail(403,'ROLE_FORBIDDEN','只有桌面最高权限可以审批维护者申请');
        const body=jsonBody(event,16384);if(!['approve','reject'].includes(body?.decision))fail(422,'DECISION_INVALID','审批决定无效');
        const result=await access.update(registry=>{
          const application=registry.maintainer_applications.find(a=>a.id===decisionMatch[1]);if(!application)fail(404,'APPLICATION_MISSING','维护者申请不存在');
          if(application.status!=='pending')fail(409,'APPLICATION_DECIDED','此申请已经处理');
          const at=new Date(clock()).toISOString();application.status=body.decision==='approve'?'approved':'rejected';application.decided_at=at;application.decided_by=auth.maintainer_id;application.note=typeof body.note==='string'?body.note.slice(0,1000):'';
          if(body.decision==='approve'){
            const requested=new Set(application.bank_ids),grants=object(body.grants)?body.grants:{};
            const selected={};for(const id of requested){const roles=Array.isArray(grants[id])?grants[id]:['upload'];if(!roles.length||roles.some(r=>r!=='upload'))fail(422,'GRANTS_INVALID','手机号维护者只能授予上传权限');selected[id]=['upload'];}
            const other=registry.wechat_accounts.find(a=>a.phone_hash===application.phone_hash&&a.openid!==application.openid&&a.status==='approved');
            if(other)fail(409,'PHONE_IN_USE','此手机号已绑定其他微信账号，请核实后再审批');
            const existing=registry.wechat_accounts.find(a=>a.openid===application.openid);
            if(existing?.status==='revoked')fail(409,'MAINTAINER_REVOKED','此微信账号已撤销，请核实后重新分配');
            if(existing&&existing.phone_hash!==application.phone_hash)fail(409,'PHONE_CHANGE_REQUIRES_ADMIN','此账号手机号已改变，请核实后重新申请');
            const details={phone:application.phone,phone_hash:application.phone_hash,phone_masked:application.phone_masked,phone_source:'self_reported',real_name:application.real_name,nickname:application.nickname,identity_description:application.identity_description,grants:{...existing?.grants,...selected},status:'approved',approved_at:at,approved_by:auth.maintainer_id};
            if(existing)Object.assign(existing,details);
            else registry.wechat_accounts.push({id:randomUUID(),openid:application.openid,created_at:at,...details});
          }
        });
        const app=result.maintainer_applications.find(a=>a.id===decisionMatch[1]);return respond(200,{id:app.id,status:app.status});
      }
      const revokeMatch=/^\/v1\/maintainer-accounts\/([0-9a-f-]{36})\/revoke$/.exec(path||'');
      if(revokeMatch&&method==='POST'){
        if(!isAdmin)fail(403,'ROLE_FORBIDDEN','只有桌面最高权限可以撤销维护者账号');
        const result=await access.update(registry=>{const account=registry.wechat_accounts.find(a=>a.id===revokeMatch[1]);if(!account)fail(404,'ACCOUNT_MISSING','维护者账号不存在');if(account.status==='revoked')return;account.status='revoked';account.revoked_at=new Date(clock()).toISOString();account.revoked_by=auth.maintainer_id;});
        return respond(200,{id:revokeMatch[1],status:result.wechat_accounts.find(a=>a.id===revokeMatch[1]).status});
      }
      if(path==='/v1/banks/promote')return respond(200,await workflow.promote(jsonBody(event,LIMITS.expandedBytes),config,auth));
      if(workflowRoute)return respond(200,await workflow.write(method,path,method==='POST'?jsonBody(event,LIMITS.expandedBytes):undefined,config,auth));
      if (!config.uploadsEnabled) fail(503, 'UPLOAD_DISABLED', '上传服务尚未启用，本地题目仍然保留');
      // Upload is an atomic merge operation in the current protocol. Never
      // accept a package into a review/pending queue when version sync is off.
      if (!config.syncEnabled) fail(503, 'SYNC_DISABLED', '云端合并服务尚未启用，本地批次仍然保留');
      throttle(`upload:${auth.openid}`, 20);
      const body=jsonBody(event,LIMITS.requestBytes);
      if(!exact(body,['format','package'])||body.format!=='qbank-confirmed-upload-1')fail(422,'CONFIRMATION_INVALID','上传必须使用当前确认包格式');
      const { delta, envelope } = decodeUpload(body.package, parseDelta, parseModelReply);
      if (!auth.grants[delta.bank_id]?.includes('upload')) fail(403, 'BANK_FORBIDDEN', '没有此题库的上传权限');
      if (config.banks.find(b => b.bank_id === delta.bank_id)?.name !== delta.name)
        fail(422, 'BANK_NAME_MISMATCH', '题库名称与云端目录不一致，请先同步题库信息');
      // Do not reserve a submission before the formal bank exists. This keeps
      // a failed pre-seed attempt from becoming a misleading retry record.
      await workflow.ensureReady(config, delta.bank_id);
      const key = `inbox/${delta.bank_id}/${delta.batch_id}.json`;
      const record = { format: 'qbank-submission-1', submission_id: sha256(`${delta.bank_id}/${delta.batch_id}`),
        bank_id: delta.bank_id, batch_id: delta.batch_id, sha256: envelope.sha256, payload_sha256: delta.sha256,
        question_count: delta.question_count, status:'merging', accepted_at: new Date(clock()).toISOString(),
        submitted_by: sha256(`${config.appId}\0${auth.openid}`), package: envelope };
      record.confirmation={version:1,actor:record.submitted_by,confirmed_at:record.accepted_at,sha256:record.sha256};
      let accepted;
      try { accepted = await store.createSubmission(key, record); }
      catch { fail(502, 'STORAGE_UNAVAILABLE', '云端保存未确认，请保留本地批次并重试'); }
      if (!accepted || accepted.record?.format !== 'qbank-submission-1')
        fail(502, 'STORAGE_UNAVAILABLE', '云端记录无效，请联系维护者');
      if (accepted.record.sha256 !== record.sha256 || accepted.record.bank_id !== delta.bank_id || accepted.record.batch_id !== delta.batch_id || accepted.record.submitted_by !== record.submitted_by)
        fail(409, 'BATCH_CONFLICT', '此批次已提交不同内容，请使用新批次提交修改');
      let merged;
      try { merged=await workflow.mergeSubmission(config,accepted.record,delta,auth); }
      catch(error){ if(error instanceof HttpError)throw error; fail(502,'MERGE_UNAVAILABLE','云端已保存上传包，但尚未完成合并；请重试同一批次'); }
      return respond(accepted.created ? 201 : 200, { receipt: receipt(accepted.record,merged.merge), duplicate: !accepted.created,
        merged: merged.merged, version: merged.manifest, merge: merged.merge });
    } catch (error) {
      if (error instanceof HttpError) return respond(error.status, { error: { code: error.code, message: error.message,
        ...(error.details ? { details: error.details } : {}) } });
      // Never echo exception strings, request bodies, login codes, tokens or SDK credentials.
      return respond(500, { error: { code: 'INTERNAL_ERROR', message: '服务暂不可用，请保留本地数据后重试' } });
    }
  };
}

module.exports = { createHandler, loadConfig, decodeUpload, LIMITS, VERSION, HttpError, sha256 };
