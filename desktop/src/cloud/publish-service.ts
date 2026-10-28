import {invoke} from '@tauri-apps/api/core';
import {UploadError} from '../../shared/queue';
import {cloudAccess,cloudOrigin,cloudCall} from './session-service';
export type PublishJob={id:string;origin:string;actor:string;path:string;body:Record<string,unknown>;status:'pending'|'done'|'failed';error:string};
export async function publishJobs():Promise<PublishJob[]>{return await invoke<PublishJob[]|null>('client_state',{key:'publish-operations',value:null})||[];}
let publishing=false;
export async function cloudMutation(path:string,body:Record<string,unknown>,retryId?:string){
 if(publishing)throw Error('已有合并操作正在执行');publishing=true;
 try{
  const access=cloudAccess();if(!access?.openid)throw Error('请先登录维护者');
  const jobs=await publishJobs(),origin=cloudOrigin(),actor=access.openid;
  let job=retryId?jobs.find(j=>j.id===retryId):jobs.find(j=>j.status==='pending'&&j.origin===origin&&j.actor===actor&&j.path===path&&JSON.stringify(j.body)===JSON.stringify(body));
  if(retryId&&!job)throw Error('合并任务不存在');
  if(job&&(job.origin!==origin||job.actor!==actor))throw Error('请使用原服务地址和维护者身份重试');
  if(!job){job={id:crypto.randomUUID(),origin,actor,path,body,status:'pending',error:''};jobs.push(job);await invoke('client_state',{key:'publish-operations',value:jobs});}
  const current=job;
  try{const result=await cloudCall(current.path,{...current.body,operation_id:current.id},true);current.status='done';current.error='';await invoke('client_state',{key:'publish-operations',value:jobs.filter(j=>j.status!=='done'||j===current)});return result;}
  catch(e){const status=e instanceof UploadError?e.status:0;current.error=String(e);if(status>=400&&status<500&&![401,403,408,429].includes(status))current.status='failed';await invoke('client_state',{key:'publish-operations',value:jobs});throw e;}
 }finally{publishing=false;}
}
