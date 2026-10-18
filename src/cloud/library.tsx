import './cloud.css';
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {CloudLogin} from './login';
import {cloudAccess} from '../cloud-client';
import {promoteBank,promotionTasks,type PromotionTask} from './promotion';
import type {Bank} from '../types';
export function CloudLibrary({banks,onClose,onChanged,onDeleted}:{banks:Bank[];onClose:()=>void;onChanged:()=>Promise<unknown>;onDeleted:(id:string)=>Promise<unknown>}){
 const [tasks,setTasks]=useState<PromotionTask[]>([]),[busy,setBusy]=useState(''),[message,setMessage]=useState(''),[,render]=useState(0);
 const [deleting,setDeleting]=useState<Bank|null>(null);
 const refresh=()=>promotionTasks().then(setTasks);
 useEffect(()=>{void refresh().catch(e=>setMessage(String(e)))},[]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(!busy)onClose()}};window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true)},[busy,onClose]);
 const canCreate=cloudAccess()?.capabilities?.includes('cloud_bank:create');
 async function run(bank:Bank,task?:PromotionTask){if(busy)return;
  if(!task&&!window.confirm(`将「${bank.name}」的 ${bank.count} 道题设为自动同步云端题库？首版将可供所有用户下载。会先保留本地备份，转换期间仅锁定这个题库。`))return;
  setBusy(bank.id);setMessage('正在备份、上传首版并核验目录…');try{const path=await promoteBank(bank,task);await onChanged();setMessage(`已启用云端同步。转换前备份：${path}`)}catch(e){setMessage(String(e))}finally{setBusy('');await refresh().catch(()=>{})}
 }
 async function remove(){if(!deleting||busy)return;const bank=deleting;setBusy(bank.id);setMessage('正在备份并删除本地题库…');
  try{const path=await invoke<string>('delete_bank',{bankId:bank.id,version:bank.version});setDeleting(null);await onDeleted(bank.id);setMessage(`已删除「${bank.name}」。删除前的完整备份：${path}。如需恢复，可在“设置与维护”中选择“校验并恢复完整备份”。`)}catch(e){setMessage(String(e))}finally{setBusy('')}
 }
 return <div className="modal-backdrop"><section className="modal large library-manager" role="dialog" aria-modal="true" aria-label="题库管理"><button className="close-modal" aria-label="关闭题库管理" disabled={!!busy} onClick={onClose}>×</button><h2>题库管理</h2><p>管理本地题库与可编辑副本。云端及发布题库保留同步，不支持删除。</p>
 {message&&<p className="callout library-message" role="status">{message}</p>}
 <div className="library-banks">{banks.map(bank=>{const task=tasks.find(t=>t.bankId===bank.id),confirming=deleting?.id===bank.id;return <article className="library-bank" key={bank.id}>
  <div className="library-bank-summary"><div><b>{bank.name}</b><p>{bank.count.toLocaleString()} 题 · {bank.read_only?'云端 / 发布题库':task?.status==='pending'?'转换结果待确认':'本地可编辑题库'} · v{bank.version}</p></div>
   <div className="library-bank-actions">{bank.read_only?<span className="library-protected">不支持删除</span>:<>
    {canCreate&&<button disabled={!!busy||!!deleting} onClick={()=>void run(bank,task)}>{busy===bank.id&&!deleting?'正在启用…':task?.status==='pending'?'恢复原转换任务':'设为云端题库'}</button>}
    <button className="danger" disabled={!!busy||!!deleting||!!task} title={task?'云端转换任务关联题库不可删除':undefined} aria-label={`删除本地题库：${bank.name}`} onClick={()=>{setMessage('');setDeleting(bank)}}>删除</button>
   </>}</div>
  </div>
  {confirming&&<div className="library-delete-confirm" role="group" aria-label={`确认删除：${bank.name}`}><b>删除「{bank.name}」？</b><p>本库题目、回收站内容、录题草稿和历史记录将一并从本机移除。删除前会保存完整数据库备份，其他题库保持原样。</p><div className="library-bank-actions"><button disabled={!!busy} onClick={()=>setDeleting(null)}>取消</button><button className="danger" disabled={!!busy} onClick={()=>void remove()}>{busy?'正在备份并删除…':'确认删除本地题库'}</button></div></div>}
 </article>})}</div>
 {!banks.length&&<p className="callout">还没有题库，可从侧栏新建或导入。</p>}
 <details className="library-cloud-settings"><summary>云端连接与维护者登录</summary><p>具有最高权限的桌面维护者可将本地题库的完整首版发布到云端，之后自动检查版本。</p><CloudLogin disabled={!!busy||!!deleting} onChange={()=>render(n=>n+1)}/>{!canCreate&&<p>云端题库创建需要最高权限；普通上传与合并授权不包含此能力。</p>}</details>
 </section></div>;
}
