// Generated from shared/sync.ts.
import {unpackText,CLOUD_FILE_FORMAT} from './codec';
import {validTime,validateStandardQuestion,sha256,identityKey,type IntakeQuestion} from './intake';
export type SyncQuestion=Omit<IntakeQuestion,'answer'> & {answer:string[]|boolean|null; cloud_layer?:string};
export type CloudManifest={bank_id:string;name:string;revision:number;release_version:number;sha256:string;bytes:number;minimum_client:string;updated_at:string;snapshot_format?:string;protocol?:number;merged_at?:string|null;release_name?:string|null;release_id?:string|null};
export type CloudSnapshot={format:'qbank-snapshot-1'|'qbank-snapshot-2';merged_at?:string|null;release_name?:string|null;release_id?:string|null;bank_id:string;name:string;revision:number;release_version:number;updated_at:string;
 formal:SyncQuestion[]|null;pending:SyncQuestion[];removed:{question_id:string;status:'merged'|'rejected'}[]};
export function reviewStates(snapshot:CloudSnapshot|null):Map<string,string>{
 const states=new Map<string,string>();
 if(snapshot){for(const r of snapshot.removed)states.set(r.question_id,r.status);
  for(const q of snapshot.pending)states.set(q.question_id,q.status==='verified'?'confirmed':'pending');}
 return states;
}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function readManifest(value:unknown):CloudManifest{
 const m=value as CloudManifest;
 if(!m||!uuid.test(m.bank_id)||typeof m.name!=='string'||!m.name.trim()||m.name.length>100||!Number.isSafeInteger(m.revision)||m.revision<0
  ||!Number.isSafeInteger(m.release_version)||m.release_version<0||!/^[0-9a-f]{64}$/.test(m.sha256)||!Number.isSafeInteger(m.bytes)||m.bytes<0||m.bytes>4194304
  ||typeof m.minimum_client!=='string'||!/^\d+\.\d+\.\d+$/.test(m.minimum_client))throw Error('云端版本清单无效，继续使用本地题库');
 if(m.protocol!=null&&![1,2].includes(m.protocol))throw Error('题库协议已更新，请升级客户端');
 const needed=m.minimum_client.split('.').map(Number),current=[0,2,7];
 for(let i=0;i<3;i++){if(needed[i]>current[i])throw Error('此题库需要更新客户端，请先升级程序');if(needed[i]<current[i])break;}
 if(m.protocol===2&&(m.merged_at!=null&&!validTime(m.merged_at)||m.release_id!=null&&!/^[a-f0-9]{64}$/.test(m.release_id)||m.release_name!=null&&(typeof m.release_name!=='string'||m.release_name.length>220||/[\\/:*?"<>|\x00-\x1f]/.test(m.release_name))))throw Error('云端结果名称或时间无效');
 return m;
}
export function snapshotPayload(value:unknown):{payload:string;sha256:string}{
 const v=value as {format?:string;payload:string;sha256:string};
 return v?.format===CLOUD_FILE_FORMAT?{payload:unpackText(v),sha256:v.sha256}:v;
}
export function snapshotPath(m:CloudManifest){return `/v1/banks/${m.bank_id}/${m.snapshot_format===CLOUD_FILE_FORMAT?'snapshot-file':'snapshot'}`;}
export function readSnapshot(value:unknown,m:CloudManifest):CloudSnapshot{
 const w=snapshotPayload(value);
 if(!w||typeof w.payload!=='string'||w.payload.length>4194304||w.sha256!==m.sha256||sha256(w.payload)!==m.sha256)throw Error('云端题库摘要校验失败，旧版仍然保留');
 // UTF-8 byte length without TextEncoder in the Mini Program.
 let bytes=0;for(const c of w.payload){const p=c.codePointAt(0)!;bytes+=p<128?1:p<2048?2:p<65536?3:4;}
 if(bytes!==m.bytes)throw Error('云端题库大小不一致');
 const s=JSON.parse(w.payload) as CloudSnapshot;
 if(!['qbank-snapshot-1','qbank-snapshot-2'].includes(s.format)||s.bank_id!==m.bank_id||s.name!==m.name||s.revision!==m.revision||s.release_version!==m.release_version
  ||!(s.formal===null||Array.isArray(s.formal))||!Array.isArray(s.pending)||!Array.isArray(s.removed)||(s.formal?.length||0)+s.pending.length>20000)throw Error('云端题库身份或结构无效');
 if(m.protocol===2&&(s.format!=='qbank-snapshot-2'||s.merged_at!==m.merged_at||s.release_name!==m.release_name||s.release_id!==m.release_id))throw Error('版本结果信息不一致');
 for(const layer of [s.formal||[],s.pending]){
  const ids=new Set();for(const q of layer){
   validateStandardQuestion(q,s.name,layer!==s.pending);
   if(ids.has(q.question_id))throw Error('云端题目 ID 重复');
   ids.add(q.question_id);
  }
 }
 if(s.pending.some(q=>!['unreviewed','verified'].includes(q.status))||s.removed.some(r=>!uuid.test(r.question_id)||!['merged','rejected'].includes(r.status)))throw Error('候选题状态无效');
 return s;
}
export function combineLayers(formal:SyncQuestion[],pending:SyncQuestion[],draft:SyncQuestion[]):SyncQuestion[]{
 const result:SyncQuestion[]=[],ids=new Set<string>(),content=new Set<string>();
 for(const [layer,questions] of [['formal',formal],['pending',pending],['draft',draft]] as const){
  for(const q of questions){const key=identityKey(q);if(ids.has(q.question_id)||(layer!=='formal'&&content.has(key)))continue;ids.add(q.question_id);content.add(key);result.push({...q,cloud_layer:layer});}
 }
 return result;
}
