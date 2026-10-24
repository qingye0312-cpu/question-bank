'use strict';

const {HttpError,OPENID}=require('./common.cjs');

function createWechatPhoneExchange(fetchImpl = fetch) {
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
  return async function exchangePhone({appId,appSecret,loginCode,phoneCode}){
    const sessionUrl=new URL('https://api.weixin.qq.com/sns/jscode2session');
    sessionUrl.search=new URLSearchParams({appid:appId,secret:appSecret,js_code:loginCode,grant_type:'authorization_code'}).toString();
    const session=await json(sessionUrl);
    if(!OPENID.test(session.openid||''))throw new HttpError(401,'WECHAT_LOGIN_FAILED','微信登录凭证无效，请重新登录');
    const tokenUrl=new URL('https://api.weixin.qq.com/cgi-bin/token');
    tokenUrl.search=new URLSearchParams({grant_type:'client_credential',appid:appId,secret:appSecret}).toString();
    const access=await json(tokenUrl);
    if(typeof access.access_token!=='string'||!access.access_token)throw new HttpError(502,'WECHAT_UNAVAILABLE','微信手机号接口暂不可用，请稍后重试');
    const phone=await json('https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token='+encodeURIComponent(access.access_token),{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:phoneCode})
    });
    const number=phone.phone_info?.phoneNumber;
    if(typeof number!=='string'||!number.trim())throw new HttpError(401,'WECHAT_PHONE_FAILED','手机号授权已失效，请重新点击授权');
    return {openid:session.openid,unionid:session.unionid,phone:number};
  };
}

module.exports = { createWechatPhoneExchange };
