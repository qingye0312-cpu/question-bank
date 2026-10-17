'use strict';

const COS = require('cos-nodejs-sdk-v5');
const { createHandler } = require('./service.cjs');
const { createCosStore, createWechatExchange } = require('./adapters.cjs');
// Generated from shared/intake.ts by scripts/build-cloud.mjs; included in the deploy ZIP.
const { parseDelta, validateStandardQuestion,parseModelReply } = require('./intake.cjs');

const store = createCosStore({ clientFactory: env => {
  if (!env.TENCENTCLOUD_SECRETID || !env.TENCENTCLOUD_SECRETKEY || !env.TENCENTCLOUD_SESSIONTOKEN)
    throw new Error('SCF running role credentials are unavailable');
  return new COS({ SecretId: env.TENCENTCLOUD_SECRETID, SecretKey: env.TENCENTCLOUD_SECRETKEY,
    SecurityToken: env.TENCENTCLOUD_SESSIONTOKEN, Protocol: 'https:', Timeout: 4000,
    AutoSwitchHost: false, UploadCheckContentMd5: true });
} });

exports.main_handler = createHandler({ store, exchangeCode: createWechatExchange(), parseDelta, validateStandardQuestion,parseModelReply });
