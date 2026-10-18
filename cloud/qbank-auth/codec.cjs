'use strict';
const {gzipSync,gunzipSync,inflateRawSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const FORMAT='qbank-cloud-file-1',MAX_RAW=4194304,MAX_COMPRESSED=4259840;
const hash=b=>createHash('sha256').update(b).digest('hex');
function packText(text){
 const raw=Buffer.from(text,'utf8');if(!raw.length||raw.length>MAX_RAW)throw Error('Cloud file exceeds expanded limit');
 const bytes=gzipSync(raw,{level:6});if(bytes.length>MAX_COMPRESSED)throw Error('Cloud file exceeds compressed limit');
 return {format:FORMAT,encoding:'gzip+base64',uncompressed_size:raw.length,sha256:hash(raw),data:bytes.toString('base64')};
}
function unpackText(value){
 if(!value||value.format!==FORMAT||value.encoding!=='gzip+base64'||!Number.isSafeInteger(value.uncompressed_size)
  ||value.uncompressed_size<1||value.uncompressed_size>MAX_RAW||typeof value.sha256!=='string'||! /^[a-f0-9]{64}$/.test(value.sha256)
  ||typeof value.data!=='string'||value.data.length>Math.ceil(MAX_COMPRESSED/3)*4||value.data.length%4||! /^[A-Za-z0-9+/]*={0,2}$/.test(value.data))throw Error('Invalid cloud file');
 const bytes=Buffer.from(value.data,'base64');if(bytes.length<18||bytes.length>MAX_COMPRESSED||bytes.toString('base64')!==value.data)throw Error('Invalid base64');
 // Writers use a plain single-member gzip stream; reject extra members and trailing bytes.
 if(bytes[0]!==31||bytes[1]!==139||bytes[2]!==8||bytes[3]!==0)throw Error('Unsupported gzip header');
 const check=inflateRawSync(bytes.subarray(10,-8),{maxOutputLength:value.uncompressed_size,info:true});
 if(check.engine.bytesWritten!==bytes.length-18)throw Error('Multiple gzip members or trailing bytes');
 const raw=gunzipSync(bytes,{maxOutputLength:value.uncompressed_size});
 if(raw.length!==value.uncompressed_size||hash(raw)!==value.sha256)throw Error('Invalid cloud checksum');
 return new TextDecoder('utf-8',{fatal:true}).decode(raw);
}
module.exports={FORMAT,packText,unpackText};
