import {invoke} from '@tauri-apps/api/core';
import {packText} from '../../shared/codec';
import {readManifest,readSnapshot,snapshotPath,snapshotPayload} from '../../shared/sync';
import {hasPermission} from '../../shared/export-permission';
import {cloudAccess,cloudCall,cloudOrigin,fetchCatalog,refreshAccess} from '../cloud-client';
import type {Bank} from '../types';
export type PromotionTask={id:string;bankId:string;origin:string;actor:string;status:'pending'|'done';backup:string;snapshot:{bank_id:string;name:string;questions:unknown[]}};
export const promotionTasks=()=>invoke<PromotionTask[]>('promotion_tasks');
let running=false;
export async function promoteBank(bank:Bank,retry?:PromotionTask){
 if(running)throw Error('已有题库转换正在执行');running=true;
 try{
  const origin=cloudOrigin(),access=cloudAccess();
  if(!access?.openid||!hasPermission(access.capabilities,'cloud_bank:create'))throw Error('请使用具有云库创建权限的账号登录');
  const check=()=>{if(cloudOrigin()!==origin||cloudAccess()?.openid!==access.openid)throw Error('登录或服务地址已改变，请使用原身份恢复转换');};
  const health=await cloudCall<{capabilities:string[]}>('/health');check();
  if(!hasPermission(health.capabilities,'cloud-bank-promotion-v1'))throw Error('云端尚未升级到支持题库创建的版本');
  const task=retry||await invoke<PromotionTask>('promotion_prepare',{bankId:bank.id,origin,actor:access.openid,version:bank.version});
  if(task.origin!==origin||task.actor!==access.openid)throw Error('请使用原创建身份与服务地址恢复');check();
  await cloudCall('/v1/banks/promote',{operation_id:task.id,package:packText(JSON.stringify(task.snapshot))},true);check();
  const catalog=await fetchCatalog(),entry=catalog.find(b=>b.bank_id===bank.id);check();
  if(!entry||entry.revision<1)throw Error('首版目录尚未激活，请恢复原任务');
  const manifest=readManifest(await cloudCall(`/v1/banks/${bank.id}/manifest`));
  const wrapper=await cloudCall(snapshotPath(manifest));readSnapshot(wrapper,manifest);check();
  await invoke('cloud_apply',snapshotPayload(wrapper));
  if(!(await promotionTasks()).some(t=>t.id===task.id&&t.status==='done'))throw Error('本地转换尚未完成，请恢复原任务');
  await refreshAccess();return task.backup;
 }finally{running=false;}
}
