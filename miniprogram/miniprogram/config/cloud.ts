// This fixed SCF Function URL serves development, trial and release builds.
// No application secret, cloud key or session token belongs in this file.
const AUTH_ORIGIN = 'https://1324463245-3bbpy3eujf.ap-guangzhou.tencentscf.com';
export const PRODUCTION_AUTH_ORIGIN = AUTH_ORIGIN;
const DEVELOPMENT_AUTH_ORIGIN = AUTH_ORIGIN;
export function authOrigin():string {
  const app=wx.getAccountInfoSync().miniProgram;
  if(app.appId!=='wx22c8135ae81d3acc')return '';
  return PRODUCTION_AUTH_ORIGIN || (app.envVersion==='develop'?DEVELOPMENT_AUTH_ORIGIN:'');
}
