import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {packText,unpackText} from '../shared/codec.ts';
import {newDraft,pasteDraft,reviseDraft,DraftAutosave,migrationId} from '../shared/draft.ts';
import {failedJob,UploadError} from '../shared/queue.ts';
const nodeCodec=createRequire(import.meta.url)('../cloud/qbank-auth/codec.cjs');
const reply={format:'qbank-photo-question-1',type:'single',stem:'题干',options:[{key:'A',content:'一'},{key:'B',content:'二'}],answer:['A'],answer_origin:'inferred',explanation:'解析',model:{name:'test',version:'1',version_source:'user'},warnings:[]};
test('cloud gzip+Base64 is cross-runtime, bounded and detects size, hash, CRC and UTF-8 corruption',()=>{
 for(const text of ['中文 🧪 𠮷',JSON.stringify({questions:Array.from({length:200},()=>reply)})]){
  assert.equal(unpackText(nodeCodec.packText(text)),text);assert.equal(nodeCodec.unpackText(packText(text)),text);
 }
 const envelope=packText('content');
 for(const broken of [{...envelope,sha256:'0'.repeat(64)},{...envelope,uncompressed_size:1},{...envelope,data:envelope.data.slice(1)}]){assert.throws(()=>unpackText(broken));assert.throws(()=>nodeCodec.unpackText(broken));}
 assert.throws(()=>packText('a'.repeat(4194305)));
 const invalid=gzipSync(Buffer.from([255]));
 const badUtf8={...envelope,data:invalid.toString('base64'),uncompressed_size:1,sha256:createHash('sha256').update(Buffer.from([255])).digest('hex')};
 assert.throws(()=>unpackText(badUtf8));assert.throws(()=>nodeCodec.unpackText(badUtf8));
 const concatenated={...nodeCodec.packText('ab'),data:Buffer.concat([gzipSync('a'),gzipSync('b')]).toString('base64')};
 for(const decode of [unpackText,nodeCodec.unpackText]){
  assert.throws(()=>decode(concatenated));
  const crc=Buffer.from(envelope.data,'base64');crc[crc.length-8]^=1;
  assert.throws(()=>decode({...envelope,data:crc.toString('base64')}));
 }
 const bomb=gzipSync(Buffer.alloc(4194305,65));assert.throws(()=>unpackText({...envelope,data:bomb.toString('base64')}));
});
test('draft parse preserves nine options, unknown types, extra fields and mixed answer data for correction',()=>{
 const base=newDraft(randomUUID(),randomUUID()),nine={...reply,options:Array.from({length:9},(_,i)=>({key:String.fromCharCode(65+i),content:String(i)}))};
 const d=pasteDraft(base,JSON.stringify(nine));assert.equal(d.reply.options.length,9);assert.ok(d.issues.length);assert.match(d.raw,/'?I'?/);
 for(const bad of [{...reply,type:'essay'},{...reply,answer:[]},{...reply,extra:'do not lose'},{...reply,answer:['A',7]},{...reply,options:[{key:'A',content:'same'},{key:'B',content:'same'}]}])assert.ok(pasteDraft(base,JSON.stringify(bad)).issues.length);
 const valid=pasteDraft(base,JSON.stringify(reply));assert.deepEqual(valid.issues,[]);const edited=reviseDraft(valid,{reply:{...valid.reply,answer:[]}});assert.ok(edited.issues.length);assert.equal(edited.recordedAt,base.recordedAt);
 assert.equal(migrationId(base.bankId,0,reply),migrationId(base.bankId,0,reply));
});
test('autosave coalesces edits, serializes revisions, retains newest input after failure and flushes before leaving',async()=>{
 const base=newDraft(randomUUID(),randomUUID()),writes=[],saved=[];let fail=true,release;
 const saver=new DraftAutosave(async(r,expected)=>{writes.push([r.revision,expected]);if(fail)throw Error('disk full');if(r.revision===2)await new Promise(r=>release=r);return r},r=>saved.push(r),()=>{});
 const r1=pasteDraft(base,JSON.stringify(reply)),r2=reviseDraft(r1,{reply:{...reply,stem:'second'}});saver.set(r1);saver.set(r2);
 await assert.rejects(saver.flush(),/disk full/);assert.deepEqual(writes,[[2,0]]);
 fail=false;const pending=saver.flush();await Promise.resolve();saver.set(reviseDraft(r2,{reply:{...reply,stem:'newest'}}));release();await pending;
 assert.deepEqual(writes,[[2,0],[2,0],[3,2]]);assert.equal(saved.at(-1).reply.stem,'newest');saver.dispose();
});
test('only recoverable failures retry automatically; content and malformed receipt errors remain visible',()=>{
 const job={attempts:0};assert.equal(failedJob(job,new Error('bad receipt')).status,'failed');assert.equal(failedJob(job,new UploadError('offline',0,'NETWORK')).status,'retry');assert.equal(failedJob(job,new UploadError('disk',0,'RECEIPT_SAVE_FAILED')).status,'retry');assert.equal(failedJob(job,new UploadError('expired',401)).status,'paused');assert.equal(failedJob(job,new UploadError('too large',413)).status,'failed');
});
