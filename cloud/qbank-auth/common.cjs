'use strict';
const {createHash}=require('node:crypto');
const VERSION = '0.2.7';
const LIMITS = Object.freeze({ requestBytes: 768 * 1024, compressedBytes: 512 * 1024,
  expandedBytes: 4 * 1024 * 1024, questions: 1000, sessionSeconds: 900 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const OPENID = /^[A-Za-z0-9_-]{10,128}$/;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class HttpError extends Error {
  constructor(status, code, message, details) { super(message); Object.assign(this, { status, code, details }); }
}
function fail(status, code, message, details) { throw new HttpError(status, code, message, details); }
function exact(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

module.exports={VERSION,LIMITS,UUID,HASH,OPENID,sha256,object,HttpError,fail,exact};
