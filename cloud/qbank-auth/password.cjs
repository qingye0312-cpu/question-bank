'use strict';

const {randomBytes,scrypt:nodeScrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {fail}=require('./common.cjs');
const scrypt=promisify(nodeScrypt);
const COST={N:1<<14,r:8,p:5,keyLength:64,maxmem:64*1024*1024};
const DUMMY_HASH=`scrypt$${COST.N}$${COST.r}$${COST.p}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(COST.keyLength).toString('base64url')}`;

function passwordLength(value){return typeof value==='string'?Array.from(value).length:0;}
function validatePassword(value){
  if(typeof value!=='string'||passwordLength(value)<8||passwordLength(value)>128||Buffer.byteLength(value,'utf8')>512
    ||!/[A-Z]/.test(value)||!/[a-z]/.test(value)||!/[0-9]/.test(value))
    fail(422,'PASSWORD_INVALID','密码至少 8 位，且需包含大写字母、小写字母和数字');
}
function validUsername(value){return typeof value==='string'&&/^[a-z0-9][a-z0-9._-]{2,30}[a-z0-9]$/.test(value);}
function normalizeUsername(value){return typeof value==='string'?value.trim().toLowerCase():'';}
async function derive(value,salt){return scrypt(value,salt,COST.keyLength,{N:COST.N,r:COST.r,p:COST.p,maxmem:COST.maxmem});}
async function hashPassword(value){
  validatePassword(value);
  const salt=randomBytes(16),derived=await derive(value,salt);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
async function verifyPassword(value,encoded){
  if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>512)return false;
  const parts=typeof encoded==='string'?encoded.split('$'):[];
  if(parts.length!==6||parts[0]!=='scrypt'||Number(parts[1])!==COST.N||Number(parts[2])!==COST.r||Number(parts[3])!==COST.p)return false;
  const salt=Buffer.from(parts[4],'base64url'),expected=Buffer.from(parts[5],'base64url');
  if(salt.length!==16||expected.length!==COST.keyLength)return false;
  const actual=await derive(value,salt);
  return timingSafeEqual(actual,expected);
}

module.exports={DUMMY_HASH,hashPassword,normalizeUsername,validUsername,validatePassword,verifyPassword};
