import './cloud.css';
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {cloudAccess} from '../cloud-client';
import {promoteBank,promotionTasks,type PromotionTask} from './promotion';
import {CloudPanel} from '../cloud-panel';
import {MaintainerAdmin} from './maintainers';
import type {Bank} from '../types';

type LibraryTab='local'|'cloud'|'maintainers';

export function CloudLibrary({banks,onClose,onChanged,onDeleted,onCreated}:{banks:Bank[];onClose:()=>void;onChanged:()=>Promise<unknown>;onDeleted:(id:string)=>Promise<unknown>;onCreated:(id:string)=>void}){
 const [tasks,setTasks]=useState<PromotionTask[]>([]),[busy,setBusy]=useState(''),[message,setMessage]=useState(''),[newBankName,setNewBankName]=useState(''),[,render]=useState(0);
 const [deleting,setDeleting]=useState<Bank|null>(null),[tab,setTab]=useState<LibraryTab>('local');
 const refresh=()=>promotionTasks().then(setTasks);
 useEffect(()=>{void refresh().catch(e=>setMessage(String(e)))},[]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(!busy)onClose()}};window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true)},[busy,onClose]);
 const access=cloudAccess(),isHighestPrivilege=access?.auth_type==='key'&&access.capabilities?.includes('cloud_bank:create')&&access.capabilities.includes('maintainer:manage'),canCreate=access?.capabilities?.includes('cloud_bank:create');
 const selectedTab=isHighestPrivilege?tab:'local';
 useEffect(()=>{
  let previous=cloudAccess();
  const timer=window.setInterval(()=>{const current=cloudAccess();if(current!==previous){previous=current;render(n=>n+1)}},5000);
  return()=>window.clearInterval(timer);
 },[]);
 useEffect(()=>{if(!isHighestPrivilege&&tab!=='local')setTab('local')},[isHighestPrivilege,tab]);
 async function createLocalBank(){if(busy)return;const name=newBankName.trim();if(!name){setMessage('请输入题库名称。');return}setBusy('create');setMessage('正在创建本地题库…');try{const id=await invoke<string>('create_bank',{name});await onChanged();onCreated(id);setNewBankName('');setMessage(`已创建本地题库「${name}」。`)}catch(e){setMessage(String(e))}finally{setBusy('')}}
 async function run(bank:Bank,task?:PromotionTask){if(busy)return;
  if(!task&&!window.confirm(`将「${bank.name}」的 ${bank.count} 道题设为自动同步云端题库？首版将可供所有用户下载。会先保留本地备份，转换期间仅锁定这个题库。`))return;
  setBusy(bank.id);setMessage('正在备份、上传首版并核验目录…');try{const path=await promoteBank(bank,task);await onChanged();setMessage(`已启用云端同步。转换前备份：${path}`)}catch(e){setMessage(String(e))}finally{setBusy('');await refresh().catch(()=>{})}
 }
 async function remove(){if(!deleting||busy)return;const bank=deleting;setBusy(bank.id);setMessage('正在备份并删除本地题库…');
  try{const path=await invoke<string>('delete_bank',{bankId:bank.id,version:bank.version});setDeleting(null);await onDeleted(bank.id);setMessage(`已删除「${bank.name}」。删除前的完整备份：${path}。如需恢复，可在设置中选择“校验并恢复完整备份”。`)}catch(e){setMessage(String(e))}finally{setBusy('')}
 }
 return <div className="modal-backdrop"><section className="modal large library-manager" role="dialog" aria-modal="true" aria-label="题库管理"><button className="close-modal" aria-label="关闭题库管理" disabled={!!busy||!!deleting} onClick={onClose}>×</button><h2>题库管理</h2><p>本地题库、副本、云端同步与维护者授权集中在这里。</p>
  <div className="library-tabs" role="tablist" aria-label="题库管理功能">
   <button role="tab" aria-selected={selectedTab==='local'} className={selectedTab==='local'?'active':''} onClick={()=>setTab('local')}>本地题库</button>
   {isHighestPrivilege&&<button role="tab" aria-selected={selectedTab==='cloud'} className={selectedTab==='cloud'?'active':''} onClick={()=>setTab('cloud')}>云端同步与版本</button>}
   {isHighestPrivilege&&<button role="tab" aria-selected={selectedTab==='maintainers'} className={selectedTab==='maintainers'?'active':''} onClick={()=>setTab('maintainers')}>维护者与申请</button>}
  </div>
  {message&&<p className="callout library-message" role="status">{message}</p>}
  {selectedTab==='local'&&<>
   <p className="library-tab-intro">管理本地题库与可编辑副本。云端及发布题库保留同步，不支持删除。</p>
   <form className="library-create" onSubmit={e=>{e.preventDefault();void createLocalBank()}}><label htmlFor="library-new-bank">新建本地题库</label><input id="library-new-bank" value={newBankName} onChange={e=>setNewBankName(e.target.value)} maxLength={120} placeholder="输入题库名称" disabled={!!busy}/><button type="submit" disabled={!!busy||!newBankName.trim()}>{busy==='create'?'正在创建…':'创建题库'}</button></form>
   <div className="library-banks">{banks.map(bank=>{const task=tasks.find(t=>t.bankId===bank.id),confirming=deleting?.id===bank.id;return <article className="library-bank" key={bank.id}>
    <div className="library-bank-summary"><div><b>{bank.name}</b><p>{bank.count.toLocaleString()} 题 · {bank.read_only?'云端 / 发布题库':task?.status==='pending'?'转换结果待确认':'本地可编辑题库'} · v{bank.version}</p></div>
     <div className="library-bank-actions">{bank.read_only?<span className="library-protected">不支持删除</span>:<>
      {canCreate&&<button disabled={!!busy||!!deleting} onClick={()=>void run(bank,task)}>{busy===bank.id&&!deleting?'正在启用…':task?.status==='pending'?'恢复原转换任务':'设为云端题库'}</button>}
      <button className="danger" disabled={!!busy||!!deleting||!!task} title={task?'云端转换任务关联题库不可删除':undefined} aria-label={`删除本地题库：${bank.name}`} onClick={()=>{setMessage('');setDeleting(bank)}}>删除</button>
     </>}</div>
    </div>
    {confirming&&<div className="library-delete-confirm" role="group" aria-label={`确认删除：${bank.name}`}><b>删除「{bank.name}」？</b><p>本库题目、录题草稿和历史记录将一并从本机移除。删除前会保存完整数据库备份，其他题库保持原样。</p><div className="library-bank-actions"><button disabled={!!busy} onClick={()=>setDeleting(null)}>取消</button><button className="danger" disabled={!!busy} onClick={()=>void remove()}>{busy?'正在备份并删除…':'确认删除本地题库'}</button></div></div>}
   </article>})}</div>
   {!banks.length&&<p className="callout">还没有本地题库，可在上方创建。</p>}
  </>}
  {isHighestPrivilege&&selectedTab==='cloud'&&<CloudPanel embedded banks={banks} onBusy={value=>setBusy(value?'正在处理云端题库':'')} onChanged={onChanged} onClose={onClose}/>}
  {isHighestPrivilege&&selectedTab==='maintainers'&&<MaintainerAdmin banks={banks.map(b=>({bank_id:b.id,name:b.name}))} onChange={()=>{render(n=>n+1);void onChanged()}}/>}
 </section></div>;
}
