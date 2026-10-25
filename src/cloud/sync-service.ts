import {invoke} from '@tauri-apps/api/core';
import {readManifest,readSnapshot,snapshotPayload,snapshotPath,type CloudManifest} from '../../shared/sync';
import {cloudOrigin,cloudCall} from './session-service';
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
  // A rollback or administrative restore can replace content without changing
  // the public release number. Skip only when both the history revision and
  // the snapshot digest match; the digest also repairs same-revision restores.
  if(old?.revision===m.revision&&old.sha256===m.sha256)return false;
  if(m.revision===0)return false;
  const wrapper=await cloudCall<unknown>(snapshotPath(m));readSnapshot(wrapper,m);
  checkOrigin();
  await invoke('cloud_apply',snapshotPayload(wrapper));return true;
 })();syncing.set(key,task);void task.finally(()=>syncing.delete(key)).catch(()=>{});return task;
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
 let updating=false,lastSync=0;
 const wake=()=>{void runDesktopQueue().catch(()=>{});if(updating||Date.now()-lastSync<30000)return;updating=true;lastSync=Date.now();void syncDesktopCatalog().then(({changed,failed})=>{if(changed)onChanged();if(failed.length)onNotice(`部分题库暂未更新：${failed.join('、')}。已保留本地内容。`);}).catch(()=>{onNotice('云端暂未连接，继续使用本地题库。');}).finally(()=>{updating=false;});};
 const timer=setInterval(wake,15000);window.addEventListener('online',wake);window.addEventListener('focus',wake);wake();
 return()=>{clearInterval(timer);window.removeEventListener('online',wake);window.removeEventListener('focus',wake)};
}
