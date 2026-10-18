import './cloud.css';
import {useEffect,useState} from 'react';
import {CloudLogin} from './login';
import {cloudAccess} from '../cloud-client';
import {promoteBank,promotionTasks,type PromotionTask} from './promotion';
import type {Bank} from '../types';
export function CloudLibrary({banks,onClose,onChanged}:{banks:Bank[];onClose:()=>void;onChanged:()=>Promise<unknown>}){
 const [tasks,setTasks]=useState<PromotionTask[]>([]),[busy,setBusy]=useState(''),[message,setMessage]=useState(''),[,render]=useState(0);
 const refresh=()=>promotionTasks().then(setTasks);
 useEffect(()=>{void refresh().catch(e=>setMessage(String(e)))},[]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(!busy)onClose()}};window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true)},[busy,onClose]);
 const canCreate=cloudAccess()?.capabilities?.includes('cloud_bank:create');
 async function run(bank:Bank,task?:PromotionTask){if(busy)return;
  if(!task&&!window.confirm(`将「${bank.name}」的 ${bank.count} 道题设为自动同步云端题库？首版将可供所有用户下载。会先保留本地备份，转换期间仅锁定这个题库。`))return;
  setBusy(bank.id);setMessage('正在备份、上传首版并核验目录…');try{const path=await promoteBank(bank,task);await onChanged();setMessage(`已启用云端同步。转换前备份：${path}`)}catch(e){setMessage(String(e))}finally{setBusy('');await refresh().catch(()=>{})}
 }
 return <div className="modal-backdrop"><section className="modal large" role="dialog" aria-modal="true" aria-label="题库管理"><button className="close-modal" disabled={!!busy} onClick={onClose}>×</button><h2>题库管理</h2><p>选定一个本地题库后，可将其完整首版发布到云端，随后自动检查版本。</p><CloudLogin disabled={!!busy} onChange={()=>render(n=>n+1)}/>
 {banks.map(bank=>{const task=tasks.find(t=>t.bankId===bank.id);return <article className="cloud-bank" key={bank.id}><div><b>{bank.name}</b><p>{bank.count} 题 · {bank.read_only?'发布题库':task?.status==='pending'?'转换结果待确认':'本地题库'}</p></div>{canCreate&&!bank.read_only&&<button disabled={!!busy} onClick={()=>void run(bank,task)}>{busy===bank.id?'正在启用…':task?.status==='pending'?'恢复原转换任务':'设为云端题库'}</button>}</article>})}
 {!canCreate&&<p>云端题库创建需要最高权限；普通上传与合并授权不包含此能力。</p>}{message&&<p className="callout" role="status">{message}</p>}
 </section></div>;
}
