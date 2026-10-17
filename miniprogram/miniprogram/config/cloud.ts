// Set a production HTTPS origin after configuring SCF and the Mini Program request domain.
// No application secret, cloud key or session token belongs in this file.
export const PRODUCTION_AUTH_ORIGIN = '';
const DEVELOPMENT_AUTH_ORIGIN = 'https://1324463245-3bbpy3eujf.ap-guangzhou.tencentscf.com';
export function authOrigin():string {
  const app=wx.getAccountInfoSync().miniProgram;
  if(app.appId!=='wx22c8135ae81d3acc')return '';
  return PRODUCTION_AUTH_ORIGIN || (app.envVersion==='develop'?DEVELOPMENT_AUTH_ORIGIN:'');
}
