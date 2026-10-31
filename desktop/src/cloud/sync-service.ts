import {invoke} from '@tauri-apps/api/core';
import {readManifest,readSnapshot,snapshotPayload,snapshotPath,readQuestionFile,readOperationsFile,questionFilePath,operationsFilePath,type CloudManifest,type CloudOperationsFile} from '../../shared/sync';
import {cloudAccess,cloudOrigin,cloudCall} from './session-service';
import {runDesktopQueue} from './submission-runner';
export async function fetchCatalog():Promise<CloudManifest[]>{
 const result=await cloudCall<{banks:unknown[]}>('/v1/catalog');if(!Array.isArray(result.banks)||result.banks.length>100)throw Error('云端目录无效');
 const catalog=result.banks.map(readManifest);if(new Set(catalog.map(b=>b.bank_id)).size!==catalog.length)throw Error('云端目录包含重复题库');return catalog;
}
const syncing=new Map<string,Promise<boolean>>();
export function syncDesktop(bankId:string,advertised?:CloudManifest):Promise<boolean>{
 const origin=cloudOrigin(),key=`${origin}/${bankId}`;
 if(syncing.has(key))return syncing.get(key)!;
 const checkOrigin=()=>{if(origin!==cloudOrigin())throw Error('服务地址已改变，本次同步已取消，原题库仍保留');};
 const task=(async()=>{
  const m=readManifest(advertised||await cloudCall(`/v1/banks/${bankId}/manifest`));if(m.bank_id!==bankId)throw Error('题库身份不一致');
  checkOrigin();
  const versions=await invoke<{bank_id:string;revision:number;sha256:string}[]>('cloud_versions'),old=versions.find(v=>v.bank_id===bankId);
  checkOrigin();
  if(old&&m.revision<old.revision)throw Error(`云端版本倒退：本地修订 ${old.revision}，云端修订 ${m.revision}，继续保留本地题库`);
  // A rollback or administrative restore can replace content without changing
  // the public release number. Skip only when both the history revision and
  // the snapshot digest match; the digest also repairs same-revision restores.
  const contentDigest=m.question_file_sha256||m.sha256;
  if(old?.revision===m.revision&&old.sha256===contentDigest)return false;
  if(m.revision===0)return false;
  if(m.question_file_sha256&&m.operations_file_sha256&&m.question_file_format==='qbank-question-bank-1'&&m.operations_file_format==='qbank-operations-1'){
   const includeOperations=!!cloudAccess(),[questionWrapper,operationsWrapper]=await Promise.all([cloudCall<unknown>(questionFilePath(m)),includeOperations?cloudCall<unknown>(operationsFilePath(m),undefined,true):Promise.resolve(null)]);
   const question=readQuestionFile(questionWrapper,m),operations=operationsWrapper?readOperationsFile(operationsWrapper,m):null;checkOrigin();
   await invoke('cloud_clear_cached_snapshot',{bankIds:[bankId]});
   checkOrigin();
   await invoke('cloud_apply',questionFileApplyPayload(questionWrapper));
   if(operations)await cacheOperations(bankId,operations);return true;
  }
  const wrapper=await cloudCall<unknown>(snapshotPath(m));readSnapshot(wrapper,m);
  checkOrigin();
  await invoke('cloud_clear_cached_snapshot',{bankIds:[bankId]});
  checkOrigin();
  await invoke('cloud_apply',snapshotPayload(wrapper));return true;
 })();syncing.set(key,task);void task.finally(()=>{if(syncing.get(key)===task)syncing.delete(key)}).catch(()=>{});return task;
}

export function reloadDesktopCache(bankId:string,advertised:CloudManifest):Promise<boolean>{
 const origin=cloudOrigin(),key=`${origin}/${bankId}`,previous=syncing.get(key);
 const checkOrigin=()=>{if(origin!==cloudOrigin())throw Error('服务地址已改变，本次重载已取消，原题库仍保留');};
 const task=(async()=>{
  if(previous){try{await previous}catch{/* Continue with a fresh download after the in-flight sync settles. */}}
  const m=readManifest(advertised);if(m.bank_id!==bankId)throw Error('题库身份不一致');
  checkOrigin();
  let payload:{payload:string;sha256:string};let operations:CloudOperationsFile|null=null;
  if(m.question_file_sha256&&m.operations_file_sha256&&m.question_file_format==='qbank-question-bank-1'&&m.operations_file_format==='qbank-operations-1'){
   const includeOperations=!!cloudAccess(),[questionWrapper,operationsWrapper]=await Promise.all([cloudCall<unknown>(questionFilePath(m)),includeOperations?cloudCall<unknown>(operationsFilePath(m),undefined,true):Promise.resolve(null)]);
   readQuestionFile(questionWrapper,m);if(operationsWrapper)operations=readOperationsFile(operationsWrapper,m);payload=questionFileApplyPayload(questionWrapper);
  }else{const wrapper=await cloudCall<unknown>(snapshotPath(m));readSnapshot(wrapper,m);payload=snapshotPayload(wrapper);}
  checkOrigin();
  await invoke('cloud_clear_cached_snapshot',{bankIds:[bankId]});
  checkOrigin();
  await invoke('cloud_apply',payload);
  if(operations)await cacheOperations(bankId,operations);
  return true;
 })();
 syncing.set(key,task);void task.finally(()=>{if(syncing.get(key)===task)syncing.delete(key)}).catch(()=>{});return task;
}

export async function reloadDesktopBank(bankId:string):Promise<boolean>{
 const manifest=readManifest(await cloudCall(`/v1/banks/${bankId}/manifest`));
 if(manifest.bank_id!==bankId)throw Error('题库身份不一致');
 return reloadDesktopCache(bankId,manifest);
}

function questionFileApplyPayload(value:unknown){
 // The native importer accepts the pure question-bank JSON directly and
 // stores its digest as the cloud revision identity.
 return snapshotPayload(value);
}

const operationKey=(bankId:string)=>`cloud-operations:${bankId}`;
type CachedOperations=CloudOperationsFile&{origin:string};
export async function cacheOperations(bankId:string,operations:CloudOperationsFile){await invoke('client_state',{key:operationKey(bankId),value:{...operations,origin:cloudOrigin()}});}
export async function cachedOperations(bankId:string):Promise<CloudOperationsFile|null>{
 const value=await invoke<CloudOperationsFile|null>('client_state',{key:operationKey(bankId),value:null});
 return value&&value.format==='qbank-operations-1'&&(value as CachedOperations).origin===cloudOrigin()?value:null;
}
export async function loadCloudOperations(bankId:string,advertised?:CloudManifest):Promise<CloudOperationsFile>{
 const cached=await cachedOperations(bankId);if(cached&&(!advertised||cached.current_revision===advertised.revision))return cached;
 const manifest=readManifest(advertised||await cloudCall(`/v1/banks/${bankId}/manifest`));
 const wrapper=await cloudCall<unknown>(operationsFilePath(manifest),undefined,true),operations=readOperationsFile(wrapper,manifest);await cacheOperations(bankId,operations);return operations;
}

const catalogSyncs=new Map<string,Promise<{changed:boolean;failed:string[]}>>();
export function syncDesktopCatalog():Promise<{changed:boolean;failed:string[]}>{
 const origin=cloudOrigin();if(catalogSyncs.has(origin))return catalogSyncs.get(origin)!;
 const task=(async()=>{
  const catalog=await fetchCatalog();let changed=false;const failed:string[]=[];
  for(const bank of catalog){
   if(origin!==cloudOrigin())throw Error('服务地址已改变，本次同步已取消');
   try{changed=(await syncDesktop(bank.bank_id,bank))||changed;}catch(error){failed.push(`${bank.name}（${error instanceof Error?error.message:String(error)}）`);}
  }
  return {changed,failed};
 })();catalogSyncs.set(origin,task);void task.finally(()=>{if(catalogSyncs.get(origin)===task)catalogSyncs.delete(origin)}).catch(()=>{});return task;
}

export function startCloudWorker(onChanged:()=>void,onNotice:(message:string)=>void=()=>{}){
 const authenticatedInterval=30_000;
 const guestInterval=12*60*60*1000;
 const retryInterval=30_000;
 let updating=false,nextAttemptAt=0,lastMode=cloudAccess()?'authenticated':'guest';
 const errorMessage=(error:unknown)=>{
  const message=error instanceof Error?error.message:String(error);
  return (message.replace(/^Error:\s*/,'').replace(/^NETWORK:\s*/,'网络请求未完成：')||'未知错误').slice(0,180);
 };
 const wake=(force=false)=>{
  void runDesktopQueue().catch(()=>{});
  const mode=cloudAccess()?'authenticated':'guest';
  // Persistent-session restoration and login/logout both emit this event.
  // Reset the throttle when the mode changes so a newly authenticated user
  // starts the existing 30-second sync loop immediately.
  if(mode!==lastMode){lastMode=mode;nextAttemptAt=0;}
  if(updating||(!force&&Date.now()<nextAttemptAt))return;
  updating=true;
  void syncDesktopCatalog().then(({changed,failed})=>{
   if(changed)onChanged();
   if(failed.length)onNotice(`部分题库暂未更新：${failed.join('、')}。已保留本地内容。`);
   const currentMode=cloudAccess()?'authenticated':'guest';
   nextAttemptAt=Date.now()+(failed.length?retryInterval:currentMode==='authenticated'?authenticatedInterval:guestInterval);
  }).catch(error=>{
   nextAttemptAt=Date.now()+retryInterval;
   onNotice(`云端同步失败：${errorMessage(error)}；继续使用本地题库。`);
  }).finally(()=>{updating=false;});
 };
 const focus=()=>wake(true);
 const online=()=>wake(true);
 const accessChange=()=>wake(true);
 const timer=setInterval(()=>wake(),15000);
 window.addEventListener('online',online);
 window.addEventListener('focus',focus);
 window.addEventListener('qbank-cloud-access-change',accessChange);
 wake(true);
 return()=>{clearInterval(timer);window.removeEventListener('online',online);window.removeEventListener('focus',focus);window.removeEventListener('qbank-cloud-access-change',accessChange)};
}
