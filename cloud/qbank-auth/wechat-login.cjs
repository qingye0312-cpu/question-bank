'use strict';

const {HttpError,OPENID}=require('./common.cjs');

function createWechatLoginExchange(fetchImpl = fetch) {
  async function json(url, options) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(5000), redirect: 'error' }); }
    catch { throw new HttpError(502, 'WECHAT_UNAVAILABLE', '微信登录校验暂不可用，请稍后重试'); }
    if (!response.ok) throw new HttpError(502, 'WECHAT_UNAVAILABLE', '微信登录校验暂不可用，请稍后重试');
    const chunks=[];let size=0;
    for await (const chunk of response.body || []) { size+=chunk.length;if(size>8192)throw new HttpError(502,'WECHAT_UNAVAILABLE','微信响应超过限制');chunks.push(chunk); }
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new HttpError(502,'WECHAT_UNAVAILABLE','微信登录响应无法识别');}
    if(result.errcode){
      if([40029,40163,40226,40013].includes(Number(result.errcode)))throw new HttpError(401,'WECHAT_LOGIN_FAILED','微信登录凭证无效，请重新登录');
      throw new HttpError(502,'WECHAT_UNAVAILABLE','微信登录配置或调用状态异常，请联系维护者');
    }
    return result;
  }
  return async function exchangeWechat({appId,appSecret,loginCode}){
    const sessionUrl=new URL('https://api.weixin.qq.com/sns/jscode2session');
    sessionUrl.search=new URLSearchParams({appid:appId,secret:appSecret,js_code:loginCode,grant_type:'authorization_code'}).toString();
    const session=await json(sessionUrl);
    if(!OPENID.test(session.openid||''))throw new HttpError(401,'WECHAT_LOGIN_FAILED','微信登录凭证无效，请重新登录');
    return {openid:session.openid};
  };
}

module.exports = { createWechatLoginExchange };
