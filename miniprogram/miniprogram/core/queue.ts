// Generated from shared/queue.ts.
// Persistent metadata only. Credentials must never be written into these jobs.
export type UploadJob={id:string;groupId:string;bankId:string;endpoint:string;actor:string;confirmedAt:string;
 status:'queued'|'uploading'|'retry'|'paused'|'failed'|'done';attempts:number;nextAt:number;error:string;syncError?:string;protocol?:'session-v1';recordIds?:string[]};
export function failedJob(job:UploadJob,error:unknown,now=Date.now()):UploadJob {
 const e=error as {status?:number;code?:string;message?:string};
 const status=e.status||0,auth=status===401||status===403||e.code==='IDENTITY_CHANGED'||e.code==='SIGNED_OUT';
 const retry=!auth&&(e.code==='NETWORK'||e.code==='RECEIPT_SAVE_FAILED'||status===408||status===429||status>=500||e.code==='REVISION_CONFLICT');
 const attempts=job.attempts+1;
 return {...job,attempts,status:auth?'paused':retry?'retry':'failed',nextAt:retry?now+Math.min(300000,2000*2**Math.min(attempts,8)):0,error:e.message||String(error)};
}
export class UploadError extends Error {status:number;code:string;constructor(message:string,status=0,code=''){super(message);this.name='UploadError';this.status=status;this.code=code;}}
export function readyJob(job:UploadJob,now=Date.now()):boolean {return ['queued','uploading','retry'].includes(job.status)&&job.nextAt<=now;}
