'use strict';
const {UUID,HASH,object,fail,exact}=require('./common.cjs');
function envJSON(env, name, fallback) {
  try { return JSON.parse(env[name] || fallback); }
  catch { fail(503, 'CONFIG_INVALID', `服务端 ${name} 配置无效`); }
}
function loadConfig(env) {
  const banks = envJSON(env, 'QBANK_BANKS', '[]');
  if (!Array.isArray(banks) || banks.length > 100 || banks.some(b => !exact(b, ['bank_id', 'name'])
    || !UUID.test(b.bank_id) || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100)
    || new Set(banks.map(b => b.bank_id)).size !== banks.length) fail(503, 'CONFIG_INVALID', '题库目录配置无效');
  const origins = envJSON(env, 'QBANK_ALLOWED_ORIGINS', '[]');
  if (!Array.isArray(origins) || origins.some(o => typeof o !== 'string'
    || !/^(https?:\/\/[^/\s]+|tauri:\/\/localhost)$/.test(o))) fail(503, 'CONFIG_INVALID', '跨域配置无效');
  const maintainers = envJSON(env, 'QBANK_MAINTAINERS', '[]');
  if (!Array.isArray(maintainers) || maintainers.length > 100 || maintainers.some(m => !exact(m,['id','key_sha256','grants'])
    || !/^[A-Za-z0-9_-]{10,64}$/.test(m.id) || !HASH.test(m.key_sha256) || !object(m.grants)
    || Object.entries(m.grants).some(([id,roles]) => !UUID.test(id) || !Array.isArray(roles) || !roles.length || roles.some(r=>!['upload','merge'].includes(r))))
    || new Set(maintainers.map(m=>m.id)).size!==maintainers.length) fail(503,'CONFIG_INVALID','桌面维护者配置无效');
  const creators=envJSON(env,'QBANK_CLOUD_CREATORS','[]');
  if(!Array.isArray(creators)||creators.some(id=>!maintainers.some(m=>m.id===id)))fail(503,'CONFIG_INVALID','最高权限账号配置无效');
  return { banks, origins, maintainers, creators, syncEnabled: env.QBANK_SYNC_ENABLED === 'true', appId: env.QBANK_TOKEN_ISSUER || 'qbank-selfhosted-v1',
    sessionSecret: env.QBANK_SESSION_SECRET || '', authVersion: env.QBANK_AUTH_VERSION || '1',
    uploadsEnabled: env.QBANK_UPLOAD_ENABLED === 'true' };
}
function authChecks(config) {
  // Public diagnostics contain only fixed status labels, never environment values.
  return {
    QBANK_SESSION_SECRET: !config.sessionSecret ? 'missing' : HASH.test(config.sessionSecret) ? 'ok' : 'invalid',
    QBANK_BANKS: config.banks.length > 0 ? 'ok' : 'empty',
  };
}
function authConfigured(config) {
  return Object.values(authChecks(config)).every(status => status === 'ok');
}
function sessionConfigured(config) {
  const checks=authChecks(config);
  return checks.QBANK_SESSION_SECRET==='ok'&&checks.QBANK_BANKS==='ok';
}
function requireSessionConfig(config) {
  if (!sessionConfigured(config)) fail(503, 'AUTH_NOT_CONFIGURED', '会话服务尚未配置完成');
}
module.exports={loadConfig,authChecks,authConfigured,sessionConfigured,requireSessionConfig};
