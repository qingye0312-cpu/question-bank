import {gzipSync,Gunzip} from '../vendor/gzip';
import {parseDelta, sha256} from './intake';

export type UploadEnvelope = {format:'qbank-upload-1'; encoding:'gzip+base64'; uncompressed_size:number; sha256:string; data:string};
export type UploadReceipt = {submission_id:string; bank_id:string; batch_id:string; sha256:string;
  payload_sha256:string; question_count:number; status:'pending_review'|'pending_merge'; accepted_at:string};
export const UPLOAD_LIMITS = {questions:1000, expandedBytes:4194304, compressedBytes:524288, requestBytes:786432};

// WeChat does not guarantee TextEncoder. Match the shared SHA-256 UTF-8 rules,
// including non-BMP code points and replacement of lone surrogates.
export function encodeUtf8(text:string):Uint8Array {
  const bytes=new Uint8Array(text.length*3);let at=0;
  for(const ch of text){
    let c=ch.codePointAt(0)!;if(c>=0xd800&&c<=0xdfff)c=0xfffd;
    if(c<128)bytes[at++]=c;
    else if(c<2048){bytes[at++]=192|(c>>6);bytes[at++]=128|(c&63);}
    else if(c<65536){bytes[at++]=224|(c>>12);bytes[at++]=128|((c>>6)&63);bytes[at++]=128|(c&63);}
    else{bytes[at++]=240|(c>>18);bytes[at++]=128|((c>>12)&63);bytes[at++]=128|((c>>6)&63);bytes[at++]=128|(c&63);}
  }
  return bytes.slice(0,at);
}

function base64(bytes:Uint8Array):string {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', parts:string[]=[];
  let chunk='';
  for(let i=0;i<bytes.length;i+=3){
    const a=bytes[i], b=bytes[i+1]||0, c=bytes[i+2]||0;
    chunk+=chars[a>>2]+chars[((a&3)<<4)|(b>>4)]+(i+1<bytes.length?chars[((b&15)<<2)|(c>>6)]:'=')+(i+2<bytes.length?chars[c&63]:'=');
    if(chunk.length>=8192){parts.push(chunk);chunk='';}
  }
  return parts.join('')+chunk;
}

export function prepareUpload(text:string){
  if(text.length>UPLOAD_LIMITS.expandedBytes)throw new Error('本批次超过上传大小限制，请拆分后上传');
  const {delta,questions}=parseDelta(text);
  if(questions.length>UPLOAD_LIMITS.questions)throw new Error('一次上传最多 1000 题；记录保留在本地，不会自动拆包');
  const raw=encodeUtf8(text);
  if(raw.length>UPLOAD_LIMITS.expandedBytes)throw new Error('本批次压缩前超过 4 MiB，请拆分后上传');
  const compressed=gzipSync(raw,{level:6,mtime:0});
  if(compressed.length>UPLOAD_LIMITS.compressedBytes)throw new Error('本批次压缩后超过 512 KiB，请拆分后上传');
  const envelope:UploadEnvelope={format:'qbank-upload-1',encoding:'gzip+base64',uncompressed_size:raw.length,sha256:sha256(text),data:base64(compressed)};
  if(JSON.stringify(envelope).length>UPLOAD_LIMITS.requestBytes)throw new Error('上传请求过大，请拆分后上传');
  return {delta,questions,envelope};
}

export function verifyReceipt(value:unknown, expected:ReturnType<typeof prepareUpload>):UploadReceipt {
  const r=value as Partial<UploadReceipt>|null, {delta,envelope}=expected;
  if(!r||typeof r!=='object'||r.submission_id!==sha256(`${delta.bank_id}/${delta.batch_id}`)
    ||r.bank_id!==delta.bank_id||r.batch_id!==delta.batch_id||r.sha256!==envelope.sha256
    ||r.payload_sha256!==delta.sha256||r.question_count!==delta.question_count||!['pending_review','pending_merge'].includes(r.status||'')
    ||typeof r.accepted_at!=='string'||r.accepted_at.length>40||!Number.isFinite(Date.parse(r.accepted_at)))
    throw new Error('云端回执与本批次不一致，未标记上传成功；请保留本地批次并重试');
  return {submission_id:r.submission_id,bank_id:r.bank_id,batch_id:r.batch_id,sha256:r.sha256,
    payload_sha256:r.payload_sha256,question_count:r.question_count,status:r.status!,accepted_at:r.accepted_at};
}

// Do not trust the advertised size to bound decompression. Feed small chunks and
// stop before accumulated output exceeds the protocol limit.
export function unpackUpload(text:string):string {
 if(text.length>UPLOAD_LIMITS.expandedBytes)throw Error('文件过大');
 let v:any;try{v=JSON.parse(text)}catch{throw Error('文件不是有效 JSON')}
 if(v.format!=='qbank-upload-1')return text;
 if(v.encoding!=='gzip+base64'||!Number.isSafeInteger(v.uncompressed_size)||v.uncompressed_size<1||v.uncompressed_size>UPLOAD_LIMITS.expandedBytes
  ||typeof v.data!=='string'||v.data.length>700000||v.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(v.data))throw Error('压缩包格式或大小无效');
 const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',arr:number[]=[];
 for(let i=0;i<v.data.length;i+=4){const n=(chars.indexOf(v.data[i])<<18)|(chars.indexOf(v.data[i+1])<<12)|((chars.indexOf(v.data[i+2])&63)<<6)|(chars.indexOf(v.data[i+3])&63);arr.push((n>>>16)&255);if(v.data[i+2]!=='=')arr.push((n>>>8)&255);if(v.data[i+3]!=='=')arr.push(n&255);}
 const bytes=new Uint8Array(arr);if(bytes.length>UPLOAD_LIMITS.compressedBytes||bytes.length<18||base64(bytes)!==v.data)throw Error('Base64 格式或大小无效');
 const chunks:Uint8Array[]=[];let size=0,done=false;
 const stream=new Gunzip((chunk,final)=>{size+=chunk.length;if(size>v.uncompressed_size)throw Error('解压内容超过声明大小');chunks.push(chunk);done=final;});
 stream.onmember=()=>{throw Error('不接受多个拼接的 gzip 数据流')};
 try{for(let i=0;i<bytes.length;i+=1024)stream.push(bytes.subarray(i,i+1024),i+1024>=bytes.length);}catch{throw Error('压缩包损坏或解压超限')}
 if(!done||size!==v.uncompressed_size)throw Error('解压大小不一致');
 const raw=new Uint8Array(size);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.length;}
 let crc=0xffffffff;for(const b of raw){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const tail=new DataView(bytes.buffer,bytes.length-8);if(tail.getUint32(0,true)!==crc||tail.getUint32(4,true)!==size)throw Error('gzip 校验失败');
 // Percent decoding validates UTF-8 in WeChat environments without TextDecoder.
 let encoded='';for(const b of raw)encoded+='%'+b.toString(16).padStart(2,'0');
 let result:string;try{result=decodeURIComponent(encoded)}catch{throw Error('题库文字编码损坏')}
 if(sha256(result)!==v.sha256)throw Error('压缩包摘要不一致');parseDelta(result);return result;
}
