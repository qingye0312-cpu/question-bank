'use strict';
const {timingSafeEqual}=require('node:crypto');
const {VERSION,LIMITS,UUID,HASH,OPENID,sha256,object,HttpError,fail,exact}=require('./common.cjs');
const {loadConfig,authChecks,authConfigured,requireAuthConfig}=require('./config.cjs');
const {sign,verify}=require('./auth.cjs');
const {decodeUpload,jsonBody,receipt}=require('./submission.cjs');

function createHandler({ env = () => process.env, store, exchangeCode, parseDelta, parseModelReply, validateStandardQuestion, clock = Date.now }) {
  const workflow = require('./workflow.cjs').createWorkflow({store,validateStandardQuestion,clock});
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
        uploads_enabled: config.uploadsEnabled, sync_enabled: config.syncEnabled, capabilities:['confirmed-upload-v1','snapshot-v2','cloud-file-gzip-base64-v1','recorded-at-v1','merge-v1','cloud-bank-promotion-v1','session-upload-v1'], limits: LIMITS,
      });
      const publicResult = await workflow.read(method,path,config);
      if(publicResult !== undefined)return respond(200,publicResult);
      const workflowRoute = /^\/v1\/banks\/[0-9a-f-]{36}\/(review|publish|seed|candidates|history|rollback)$/.test(path||'');
      if (!workflowRoute && !['POST /v1/auth/desktop', 'POST /v1/auth/wechat', 'GET /v1/me', 'POST /v1/uploads', 'POST /v1/banks/promote'].includes(`${method} ${path}`))
        fail(404, 'NOT_FOUND', '接口不存在');
      requireAuthConfig(config);
      const now = Math.floor(clock() / 1000);
      if (method === 'POST' && headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
        fail(415, 'JSON_REQUIRED', '请使用 application/json');
      if (path === '/v1/auth/desktop') {
        throttle('login:all',100);throttle(`desktop:${String(headers['x-scf-remote-addr']||'unknown').slice(0,100)}`,10);
        const body=jsonBody(event,1024);
        if(!exact(body,['key']) || typeof body.key!=='string' || !HASH.test(body.key))fail(401,'KEY_INVALID','维护密钥无效');
        const digest=Buffer.from(sha256(body.key),'hex');
        const maintainer=config.maintainers.find(m=>timingSafeEqual(Buffer.from(m.key_sha256,'hex'),digest));
        if(!maintainer)fail(401,'KEY_INVALID','维护密钥无效或已撤销');
        return respond(200,{access_token:sign({sub:`d_${maintainer.id}`,aud:'qbank-desktop-v1',app_id:config.appId,
          auth_version:config.authVersion,key_version:maintainer.key_sha256,iat:now,exp:now+LIMITS.sessionSeconds},config),
          expires_in:LIMITS.sessionSeconds,banks:config.banks.filter(b=>Object.hasOwn(maintainer.grants,b.bank_id)),grants:maintainer.grants});
      }
      if (path === '/v1/auth/wechat') {
        throttle('login:all', 100);
        throttle(`login:${String(headers['x-scf-remote-addr'] || 'unknown').slice(0, 100)}`, 10);
        const body = jsonBody(event, 1024);
        if (!exact(body, ['code']) || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(body.code))
          fail(400, 'CODE_REQUIRED', '请提供 wx.login 返回的临时 code');
        let identity;
        try { identity = await exchangeCode({ appId: config.appId, appSecret: config.appSecret, code: body.code }); }
        catch (error) { if (error instanceof HttpError) throw error; fail(502, 'WECHAT_UNAVAILABLE', '微信登录校验暂不可用，请重试'); }
        if (!identity || !OPENID.test(identity.openid)) fail(401, 'WECHAT_LOGIN_FAILED', '微信登录凭证无效，请重新登录');
        const banks = Object.hasOwn(config.developers, identity.openid) ? config.developers[identity.openid] : [];
        if (!banks.length) fail(403, 'DEVELOPER_NOT_ALLOWED', '此微信用户尚未获得上传授权', { openid: identity.openid });
        return respond(200, { access_token: sign({ sub: identity.openid, aud: 'qbank-upload-v1',
          app_id: config.appId, auth_version: config.authVersion, iat: now, exp: now + LIMITS.sessionSeconds }, config),
        expires_in: LIMITS.sessionSeconds, openid: identity.openid, banks: config.banks.filter(b => banks.includes(b.bank_id)) });
      }
      const auth = verify(typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
        ? headers.authorization.slice(7) : null, config, now);
      if (path === '/v1/me') return respond(200, { openid: auth.openid, banks: config.banks.filter(b => auth.banks.includes(b.bank_id)),
        permissions: [...new Set(Object.values(auth.grants).flat())], grants:auth.grants, capabilities:auth.capabilities||[], uploads_enabled: config.uploadsEnabled });
      if(path==='/v1/banks/promote')return respond(200,await workflow.promote(jsonBody(event,LIMITS.expandedBytes),config,auth));
      if(workflowRoute)return respond(200,await workflow.write(method,path,method==='POST'?jsonBody(event,LIMITS.expandedBytes):undefined,config,auth));
      if (!config.uploadsEnabled) fail(503, 'UPLOAD_DISABLED', '上传服务尚未启用，本地题目仍然保留');
      throttle(`upload:${auth.openid}`, 20);
      const body=jsonBody(event,LIMITS.requestBytes),confirmed=body?.format==='qbank-confirmed-upload-1';
      if(confirmed&&!exact(body,['format','package']))fail(422,'CONFIRMATION_INVALID','上传确认格式无效');
      const { delta, envelope } = decodeUpload(confirmed?body.package:body, parseDelta, parseModelReply);
      if (!auth.grants[delta.bank_id]?.includes('upload')) fail(403, 'BANK_FORBIDDEN', '没有此题库的上传权限');
      if (config.banks.find(b => b.bank_id === delta.bank_id)?.name !== delta.name)
        fail(422, 'BANK_NAME_MISMATCH', '题库名称与云端目录不一致，请先同步题库信息');
      const key = `inbox/${delta.bank_id}/${delta.batch_id}.json`;
      const record = { format: 'qbank-submission-1', submission_id: sha256(`${delta.bank_id}/${delta.batch_id}`),
        bank_id: delta.bank_id, batch_id: delta.batch_id, sha256: envelope.sha256, payload_sha256: delta.sha256,
        question_count: delta.question_count, status: confirmed?'pending_merge':'pending_review', accepted_at: new Date(clock()).toISOString(),
        submitted_by: sha256(`${config.appId}\0${auth.openid}`), package: envelope };
      if(confirmed)record.confirmation={version:1,actor:record.submitted_by,confirmed_at:record.accepted_at,sha256:record.sha256};
      let accepted;
      try { accepted = await store.createSubmission(key, record); }
      catch { fail(502, 'STORAGE_UNAVAILABLE', '云端保存未确认，请保留本地批次并重试'); }
      if (!accepted || accepted.record?.format !== 'qbank-submission-1')
        fail(502, 'STORAGE_UNAVAILABLE', '云端记录无效，请联系维护者');
      if (accepted.record.sha256 !== record.sha256 || accepted.record.bank_id !== delta.bank_id || accepted.record.batch_id !== delta.batch_id || accepted.record.submitted_by !== record.submitted_by)
        fail(409, 'BATCH_CONFLICT', '此批次已提交不同内容，请使用新批次提交修改');
      let merged;
      if(config.syncEnabled){
        try { merged=await workflow.mergeSubmission(config,accepted.record,delta,auth); }
        catch(error){ if(error instanceof HttpError)throw error; fail(502,'MERGE_UNAVAILABLE','云端已保存上传包，但尚未完成合并；请重试同一批次'); }
      }
      const mergeInfo=merged?.merge||null;
      return respond(accepted.created ? 201 : 200, { receipt: receipt(accepted.record,mergeInfo,merged?.manifest), duplicate: !accepted.created,
        merged: merged?.merged===true, version: merged?.manifest||null, merge: mergeInfo });
    } catch (error) {
      if (error instanceof HttpError) return respond(error.status, { error: { code: error.code, message: error.message,
        ...(error.details ? { details: error.details } : {}) } });
      // Never echo exception strings, request bodies, login codes, tokens or SDK credentials.
      return respond(500, { error: { code: 'INTERNAL_ERROR', message: '服务暂不可用，请保留本地数据后重试' } });
    }
  };
}

module.exports = { createHandler, loadConfig, decodeUpload, LIMITS, VERSION, HttpError, sha256 };
