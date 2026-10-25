import './cloud/cloud.css';
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {cloudAccess,cloudCall,fetchCatalog,syncDesktop,cloudMutation} from './cloud-client';
import type {CloudManifest} from '../shared/sync';
import type {Bank,Question} from './types';

type Version={revision:number;release_version:number;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;merge_count:number};
type History={current_revision:number;release_version:number;versions:Version[]};

export function CloudPanel({banks,onChanged,onClose,onBusy,embedded=false}:{banks:Bank[];onChanged:()=>Promise<unknown>;onClose:()=>void;onBusy:(value:boolean)=>void;embedded?:boolean}){
 const [catalog,setCatalog]=useState<CloudManifest[]>([]);
 const [selected,setSelected]=useState('');
 const [history,setHistory]=useState<History|null>(null),[historyLoading,setHistoryLoading]=useState(false);
 const [,render]=useState(0);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const access=cloudAccess(),roles=access?.grants[selected]||[],canMerge=roles.includes('merge');
 const task=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);onBusy(true);setMessage('');try{await fn()}catch(e){setMessage(String(e))}finally{setBusy(false);onBusy(false)}};
 async function checkUpdates(){
  const entries=await fetchCatalog();setCatalog(entries);
  const installed=entries.filter(entry=>banks.some(bank=>bank.id===entry.bank_id));
  const results=await Promise.allSettled(installed.map(entry=>syncDesktop(entry.bank_id,entry)));
  if(installed.length)await onChanged();
  const updated=results.filter(result=>result.status==='fulfilled'&&result.value).length;
  const failed=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
  if(!installed.length)setMessage('云端目录已更新；当前没有已下载的云端题库。');
  else setMessage(`检查完成：已检查 ${installed.length} 个云端题库，${updated} 个有更新${failed.length?`；${failed.length} 个失败：${String(failed[0].reason)}`:''}。`);
 }
 const refreshHistory=async()=>{setHistory(await cloudCall<History>('/v1/banks/'+selected+'/history',undefined,true));};
 useEffect(()=>{
  let active=true;setHistory(null);setHistoryLoading(false);
  if(selected&&canMerge){setHistoryLoading(true);void cloudCall<History>('/v1/banks/'+selected+'/history',undefined,true).then(value=>{if(active)setHistory(value)}).catch(error=>{if(active)setMessage(String(error))}).finally(()=>{if(active)setHistoryLoading(false)});}
  return ()=>{active=false};
 },[selected,access?.openid,canMerge]);
 const selectedBank=catalog.find(bank=>bank.bank_id===selected);
 const panel=<section className={`modal large cloud-maintenance${embedded?' cloud-maintenance-embedded':''}`} role={embedded?'region':'dialog'} aria-label="云端题库维护">
  {!embedded&&<><button className="close-modal" disabled={busy} onClick={onClose}>×</button><h2>云端题库与维护</h2></>}
  {!selected?<>
   <button disabled={busy} onClick={()=>void task(checkUpdates)}>检查更新</button>
   {catalog.map(b=><div className="cloud-bank" key={b.bank_id}><button type="button" className="cloud-bank-name" disabled={busy} onClick={()=>{setMessage('');setSelected(b.bank_id)}}><b>{b.name}</b>{b.release_name&&<small>{b.release_name}</small>}</button><span>正式 v{b.release_version} · 修订 {b.revision}</span>{!banks.some(k=>k.id===b.bank_id)&&<button disabled={busy} onClick={()=>void task(async()=>{await syncDesktop(b.bank_id,b);await onChanged();setMessage('题库已下载')})}>下载题库</button>}</div>)}
   {!catalog.length&&<p className="callout">点击“检查更新”读取云端题库目录。</p>}
  </>:<>
   <button type="button" disabled={busy} onClick={()=>{setSelected('');setHistory(null);setMessage('')}}>返回云端题库目录</button>
   <h3>{selectedBank?.name||'题库历史版本'}</h3>
   {!canMerge?<p className="callout">当前账号没有此题库的版本历史查看权限。</p>:historyLoading?<p>正在读取历史版本…</p>:null}
  </>}
  {selected&&history&&<><p>正式版本 {history.release_version} · 修订 {history.current_revision} · 新上传会直接合并</p>
   {history.current_revision===0&&access?.capabilities?.includes('cloud_bank:create')&&<button disabled={busy||!banks.some(b=>b.id===selected)} onClick={()=>void task(async()=>{
    const questions=await invoke<Question[]>('bank_questions',{bankId:selected});
    if(!window.confirm('将本机「'+(banks.find(b=>b.id===selected)?.name||'')+'」的 '+questions.length+' 道正式题初始化为云端首版？'))return;
    await cloudMutation('/v1/banks/'+selected+'/seed',{base_revision:history.current_revision,questions});await refreshHistory();await syncDesktop(selected);await onChanged();setMessage('云端正式首版已创建');
   })}>从本机正式题初始化首版</button>}
   {!!history.versions.length?<section className="cloud-history"><h3>版本历史与回退</h3>{history.versions.map(v=><div className="cloud-bank" key={v.revision}><span><b>修订 {v.revision} · 正式 v{v.release_version}</b><small>{v.release_name||'未发布名称'} · {new Date(v.updated_at).toLocaleString()}{v.rollback_of?' · 回退自修订 '+v.rollback_of:''}</small></span><button disabled={busy||v.revision>=history.current_revision} onClick={()=>void task(async()=>{if(!window.confirm('确认将正式题库回退到修订 '+v.revision+'？当前版本会保留为历史记录。'))return;await cloudMutation('/v1/banks/'+selected+'/rollback',{base_revision:history.current_revision,target_revision:v.revision});await refreshHistory();await syncDesktop(selected);await onChanged();setMessage('已创建回退修订')})}>回退到此版本</button></div>)}</section>:<p className="callout">当前暂无可回退的历史版本。</p>}
  </>}
  {message&&<p className="callout" role="status">{message}</p>}{busy&&<p>正在处理…</p>}
 </section>;
 return embedded?panel:<div className="modal-backdrop">{panel}</div>;
}
