// Temporary HTTP is limited to this app's develop/trial builds while its public
// certificate is pending. Release builds always use HTTPS, without fallback.
// SSH, HTTP and HTTPS share the public 8013 port. No secrets belong here.
export const PRODUCTION_AUTH_ORIGIN = 'https://qbank.creart.top:8013';
export const TEST_HTTP_ORIGIN = 'http://qbank.creart.top:8013';
const APP_ID = 'wx22c8135ae81d3acc';
export function isTestHttpOrigin(origin:string):boolean {
  const app=wx.getAccountInfoSync().miniProgram;
  return origin===TEST_HTTP_ORIGIN&&app.appId===APP_ID&&(app.envVersion==='develop'||app.envVersion==='trial');
}
export function authOrigin():string {
  const app=wx.getAccountInfoSync().miniProgram;
  if(app.appId!==APP_ID)return '';
  return app.envVersion==='develop'||app.envVersion==='trial'?TEST_HTTP_ORIGIN:PRODUCTION_AUTH_ORIGIN;
}
