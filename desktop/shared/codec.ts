import {gzipSync,Gunzip} from './gzip.ts';
import {sha256} from './intake.ts';

export const CLOUD_FILE_FORMAT='qbank-cloud-file-1';
export const CLOUD_LIMITS={expandedBytes:4194304,compressedBytes:4259840};
export type CompressedFile={format:string;encoding:'gzip+base64';uncompressed_size:number;sha256:string;data:string};
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

export function base64(bytes:Uint8Array):string {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', parts:string[]=[];
  let chunk='';
  for(let i=0;i<bytes.length;i+=3){
    const a=bytes[i], b=bytes[i+1]||0, c=bytes[i+2]||0;
    chunk+=chars[a>>2]+chars[((a&3)<<4)|(b>>4)]+(i+1<bytes.length?chars[((b&15)<<2)|(c>>6)]:'=')+(i+2<bytes.length?chars[c&63]:'=');
    if(chunk.length>=8192){parts.push(chunk);chunk='';}
  }
  return parts.join('')+chunk;
}


export function packText(text:string,format=CLOUD_FILE_FORMAT,limits=CLOUD_LIMITS):CompressedFile {
 if(!text.length||text.length>limits.expandedBytes)throw Error('文件超过压缩前大小限制');
 const raw=encodeUtf8(text);if(raw.length>limits.expandedBytes)throw Error('文件超过压缩前大小限制');
 const compressed=gzipSync(raw,{level:6,mtime:0});if(compressed.length>limits.compressedBytes)throw Error('文件超过压缩后大小限制');
 return {format,encoding:'gzip+base64',uncompressed_size:raw.length,sha256:sha256(text),data:base64(compressed)};
}

export function unpackText(value:unknown,format=CLOUD_FILE_FORMAT,limits=CLOUD_LIMITS):string {
 const v=value as CompressedFile;
 if(!v||v.format!==format||typeof v.sha256!=='string'||! /^[a-f0-9]{64}$/.test(v.sha256))throw Error('压缩文件格式无效');
 if(v.encoding!=='gzip+base64'||!Number.isSafeInteger(v.uncompressed_size)||v.uncompressed_size<1||v.uncompressed_size>limits.expandedBytes
  ||typeof v.data!=='string'||v.data.length>Math.ceil(limits.compressedBytes/3)*4||v.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(v.data))throw Error('压缩包格式或大小无效');
 const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',arr:number[]=[];
 for(let i=0;i<v.data.length;i+=4){const n=(chars.indexOf(v.data[i])<<18)|(chars.indexOf(v.data[i+1])<<12)|((chars.indexOf(v.data[i+2])&63)<<6)|(chars.indexOf(v.data[i+3])&63);arr.push((n>>>16)&255);if(v.data[i+2]!=='=')arr.push((n>>>8)&255);if(v.data[i+3]!=='=')arr.push(n&255);}
 const bytes=new Uint8Array(arr);if(bytes.length>limits.compressedBytes||bytes.length<18||base64(bytes)!==v.data)throw Error('Base64 格式或大小无效');
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
 if(sha256(result)!==v.sha256)throw Error('压缩包摘要不一致');return result;
}
