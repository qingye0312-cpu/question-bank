import {invoke} from '@tauri-apps/api/core';
import {readManifest,readSnapshot,snapshotPayload,snapshotPath,type CloudManifest} from '../../shared/sync';
import {cloudOrigin,cloudCall} from './session-service';
import {runDesktopQueue} from './submission-runner';
export async function fetchCatalog():Promise<CloudManifest[]>{
 const result=await cloudCall<{banks:unknown[]}>('/v1/catalog');if(!Array.isArray(result.banks)||result.banks.length>100)throw Error('云端目录无效');return result.banks.map(readManifest);
}
const syncing=new Map<string,Promise<boolean>>();
export function syncDesktop(bankId:string):Promise<boolean>{
 const origin=cloudOrigin(),key=`${origin}/${bankId}`;
 if(syncing.has(key))return syncing.get(key)!;
 const checkOrigin=()=>{if(origin!==cloudOrigin())throw Error('服务地址已改变，本次同步已取消，原题库仍保留');};
 const task=(async()=>{
  const m=readManifest(await cloudCall(`/v1/banks/${bankId}/manifest`));if(m.bank_id!==bankId)throw Error('题库身份不一致');
  checkOrigin();
  const versions=await invoke<{bank_id:string;revision:number;sha256:string}[]>('cloud_versions'),old=versions.find(v=>v.bank_id===bankId);
  checkOrigin();
  if(old){if(old.revision>m.revision)throw Error('拒绝云端版本倒退');if(old.revision===m.revision){if(old.sha256!==m.sha256)throw Error('同版本内容发生变化');return false;}}
  if(m.revision===0)return false;
  const wrapper=await cloudCall<unknown>(snapshotPath(m));readSnapshot(wrapper,m);
  checkOrigin();
  await invoke('cloud_apply',snapshotPayload(wrapper));return true;
 })();syncing.set(key,task);void task.finally(()=>syncing.delete(key)).catch(()=>{});return task;
}

export function startCloudWorker(onChanged:()=>void){
 let updating=false,lastSync=0;
 const wake=()=>{void runDesktopQueue().catch(()=>{});if(updating||Date.now()-lastSync<30000)return;updating=true;lastSync=Date.now();void invoke<{id:string}[]>('banks').then(async banks=>{let changed=false;for(const b of banks)try{changed=(await syncDesktop(b.id))||changed;}catch{}if(changed)onChanged();}).catch(()=>{}).finally(()=>{updating=false;});};
 const timer=setInterval(wake,15000);window.addEventListener('online',wake);window.addEventListener('focus',wake);wake();
 return()=>{clearInterval(timer);window.removeEventListener('online',wake);window.removeEventListener('focus',wake)};
}
