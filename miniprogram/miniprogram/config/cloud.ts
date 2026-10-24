// All builds use the domain certificate on the shared public 8013 port.
// HTTPS failures never downgrade login, upload or downloads to HTTP.
// No secrets belong here.
export const PRODUCTION_AUTH_ORIGIN = 'https://qbank.creart.top:8013';
const APP_ID = 'wx22c8135ae81d3acc';
export function authOrigin():string {
  const app=wx.getAccountInfoSync().miniProgram;
  if(app.appId!==APP_ID)return '';
  return PRODUCTION_AUTH_ORIGIN;
}
