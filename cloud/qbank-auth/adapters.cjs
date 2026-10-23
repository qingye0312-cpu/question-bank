'use strict';

const {packText,unpackText,FORMAT}=require('./codec.cjs');
const { HttpError, LIMITS, sha256 } = require('./service.cjs');

function createCosStore({ clientFactory, env = () => process.env }) {
  const stateKey=(bankId,revision)=>`states/${bankId}/${String(999999999999-revision).padStart(12,'0')}.json`;
  const decodeState=(bytes,bankId,revision,key)=>{
    const data=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);if(data.length>8388608)throw new Error('State too large');
    const wrapper=JSON.parse(data.toString('utf8'));if(wrapper.format===FORMAT)wrapper.payload=unpackText(wrapper);
    if(typeof wrapper.payload!=='string'||sha256(wrapper.payload)!==wrapper.sha256)throw new Error('Invalid state checksum');
    const state=JSON.parse(wrapper.payload);
    if(state.format!=='qbank-state-1'||state.bank_id!==bankId||!Number.isSafeInteger(state.revision)||state.revision<1
      ||state.revision!==revision||key!==stateKey(bankId,state.revision))throw new Error('Invalid state identity');
    return state;
  };
  return {
    async readState(bankId) {
      const settings=env(), Bucket=settings.COS_RELEASE_BUCKET, Region=settings.COS_REGION;
      if(!/^[a-z0-9-]+-\d+$/.test(Bucket||'')||!/^[0-9a-f-]{36}$/.test(bankId))throw new Error('Invalid release configuration');
      const cos=clientFactory(settings), Prefix=`states/${bankId}/`;
      const list=await cos.getBucket({Bucket,Region,Prefix,MaxKeys:1});
      const Key=list.Contents?.[0]?.Key;if(!Key)return null;
      if(!new RegExp(`^states/${bankId}/[0-9]{12}\\.json$`).test(Key))throw new Error('Invalid state key');
      const data=await cos.getObject({Bucket,Region,Key,Range:'bytes=0-8388608'});
      const revision=999999999999-Number(Key.split('/').at(-1).slice(0,12));return decodeState(data.Body,bankId,revision,Key);
    },
    async readStateAt(bankId,revision) {
      const settings=env(),Bucket=settings.COS_RELEASE_BUCKET,Region=settings.COS_REGION;
      if(!/^[a-z0-9-]+-\d+$/.test(Bucket||'')||!/^[0-9a-f-]{36}$/.test(bankId)||!Number.isSafeInteger(revision)||revision<1||revision>999999999998)
        throw new Error('Invalid release configuration');
      const Key=stateKey(bankId,revision),cos=clientFactory(settings);
      try { const data=await cos.getObject({Bucket,Region,Key,Range:'bytes=0-8388608'});return decodeState(data.Body,bankId,revision,Key); }
      catch(error){if(error?.statusCode===404||error?.code==='NoSuchKey')return null;throw error;}
    },
    async listStates(bankId) {
      const settings=env(),Bucket=settings.COS_RELEASE_BUCKET,Region=settings.COS_REGION;
      if(!/^[a-z0-9-]+-\d+$/.test(Bucket||'')||!/^[0-9a-f-]{36}$/.test(bankId))throw new Error('Invalid release configuration');
      const cos=clientFactory(settings),Prefix=`states/${bankId}/`,list=await cos.getBucket({Bucket,Region,Prefix,MaxKeys:256});
      const keys=(list.Contents||[]).map(v=>v.Key).filter(k=>typeof k==='string').sort();if(keys.length>256)throw new Error('Too many state revisions');
      const result=[];for(const Key of keys){if(!new RegExp(`^states/${bankId}/[0-9]{12}\\.json$`).test(Key))throw new Error('Invalid state key');
        const revision=999999999999-Number(Key.split('/').at(-1).slice(0,12));const data=await cos.getObject({Bucket,Region,Key,Range:'bytes=0-8388608'});result.push(decodeState(data.Body,bankId,revision,Key));}
      return result.sort((a,b)=>b.revision-a.revision);
    },
    async createState(state) {
      const settings=env(),Bucket=settings.COS_RELEASE_BUCKET,Region=settings.COS_REGION;
      if(!/^[a-z0-9-]+-\d+$/.test(Bucket||'')||!/^[0-9a-f-]{36}$/.test(state.bank_id)
        ||!Number.isSafeInteger(state.revision)||state.revision<1||state.revision>999999999998)throw new Error('Invalid state');
      const cos=clientFactory(settings);
      const versioning=await cos.getBucketVersioning({Bucket,Region});
      if(!versioning.VersioningConfiguration||versioning.VersioningConfiguration.Status)throw new Error('State bucket versioning must never have been enabled');
      const payload=JSON.stringify(state),Body=Buffer.from(JSON.stringify(packText(payload)));
      const Key=`states/${state.bank_id}/${String(999999999999-state.revision).padStart(12,'0')}.json`;
      try {await cos.putObject({Bucket,Region,Key,Body,ContentLength:Body.length,ContentType:'application/json; charset=utf-8',
        CacheControl:'no-store',Headers:{'x-cos-forbid-overwrite':'true'}});return true;}
      catch(e){if(e.statusCode===409&&e.code==='FileAlreadyExists')return false;throw e;}
    },
    async createSubmission(key, record) {
      const settings = env();
      const Bucket = settings.COS_INBOX_BUCKET, Region = settings.COS_REGION;
      if (!/^[a-z0-9-]+-\d+$/.test(Bucket || '') || !/^[a-z]+-[a-z]+(?:-\d+)?$/.test(Region || '')
        || !/^inbox\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.json$/.test(key)) throw new Error('Invalid storage configuration');
      // Obtain a new client from the current SCF role credentials for every invocation.
      const cos = clientFactory(settings);
      const params = { Bucket, Region };
      const versioning = await cos.getBucketVersioning(params);
      if (!versioning.VersioningConfiguration || versioning.VersioningConfiguration.Status)
        throw new Error('Inbox versioning must never have been enabled');
      const Body = Buffer.from(JSON.stringify(packText(JSON.stringify(record))));
      try {
        await cos.putObject({ ...params, Key: key, Body, ContentLength: Body.length,
          ContentType: 'application/json; charset=utf-8', CacheControl: 'no-store',
          Headers: { 'x-cos-forbid-overwrite': 'true' } });
        return { created: true, record };
      } catch (error) {
        if (error.statusCode !== 409 || error.code !== 'FileAlreadyExists') throw error;
        // Atomic create lost a race or this is a retry; compare with the durable first record.
        const saved = await cos.getObject({ ...params, Key: key, Range: `bytes=0-${2 * LIMITS.requestBytes + 4096}` });
        const bytes = Buffer.isBuffer(saved.Body) ? saved.Body : Buffer.from(saved.Body);
        if (bytes.length > 2 * LIMITS.requestBytes + 4096) throw new Error('Stored record exceeds limit');
        const savedRecord=JSON.parse(bytes.toString('utf8'));
        return { created: false, record: savedRecord.format===FORMAT?JSON.parse(unpackText(savedRecord)):savedRecord };
      }
    },
  };
}

function createWechatExchange(fetchImpl = fetch) {
  return async function exchangeCode({ appId, appSecret, code }) {
    // This URL is fixed; callers cannot redirect login secrets to a supplied host.
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' }).toString();
    let result;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error('WeChat request failed');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8192) throw new Error('WeChat response exceeds limit');
        chunks.push(chunk);
      }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new HttpError(502, 'WECHAT_UNAVAILABLE', '微信登录校验暂不可用，请稍后重试'); }
    if (result.errcode) {
      if ([40029, 40163, 40226].includes(result.errcode))
        throw new HttpError(401, 'WECHAT_LOGIN_FAILED', '微信登录凭证无效或已使用，请重新登录');
      throw new HttpError(502, 'WECHAT_UNAVAILABLE', '微信登录配置或调用状态异常，请联系维护者');
    }
    // Discard session_key and unionid; neither is needed for this authorization service.
    return { openid: result.openid };
  };
}

module.exports = { createCosStore, createWechatExchange };
