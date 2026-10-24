// HTTPS reverse-proxy origin in front of the self-hosted Alpine service.
// Add this exact origin to the Mini Program's request domain allowlist.
// No application secret, cloud key or session token belongs in this file.
const AUTH_ORIGIN = 'https://qbank.creart.top';
export const PRODUCTION_AUTH_ORIGIN = AUTH_ORIGIN;
const DEVELOPMENT_AUTH_ORIGIN = AUTH_ORIGIN;
export function authOrigin():string {
  const app=wx.getAccountInfoSync().miniProgram;
  if(app.appId!=='wx22c8135ae81d3acc')return '';
  return PRODUCTION_AUTH_ORIGIN || (app.envVersion==='develop'?DEVELOPMENT_AUTH_ORIGIN:'');
}
