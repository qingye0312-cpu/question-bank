import './cloud/cloud.css';
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {cloudAccess,cloudCall,fetchCatalog,syncDesktop,cloudMutation} from './cloud-client';
import type {Bank,Question} from './types';

type Version={revision:number;release_version:number;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;merge_count:number};
type History={current_revision:number;release_version:number;versions:Version[]};

export function CloudPanel({banks,onChanged,onClose,onBusy,embedded=false}:{banks:Bank[];onChanged:()=>Promise<unknown>;onClose:()=>void;onBusy:(value:boolean)=>void;embedded?:boolean}){
 const [catalog,setCatalog]=useState<{bank_id:string;name:string;revision:number;release_version:number;release_name?:string|null}[]>([]);
 const [selected,setSelected]=useState(banks[0]?.id||'');
 const [history,setHistory]=useState<History|null>(null);
 const [,render]=useState(0);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const access=cloudAccess(),roles=access?.grants[selected]||[],canMerge=roles.includes('merge');
 const task=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);onBusy(true);setMessage('');try{await fn()}catch(e){setMessage(String(e))}finally{setBusy(false);onBusy(false)}};
 const refreshHistory=async()=>{setHistory(await cloudCall<History>('/v1/banks/'+selected+'/history',undefined,true));};
 useEffect(()=>{
  let active=true;setHistory(null);
  if(selected&&canMerge)void cloudCall<History>('/v1/banks/'+selected+'/history',undefined,true).then(value=>{if(active)setHistory(value)}).catch(error=>{if(active)setMessage(String(error))});
  return ()=>{active=false};
 },[selected,access?.openid,canMerge]);
 const panel=<section className={`modal large cloud-maintenance${embedded?' cloud-maintenance-embedded':''}`} role={embedded?'region':'dialog'} aria-label="云端题库维护">
  {!embedded&&<><button className="close-modal" disabled={busy} onClick={onClose}>×</button><h2>云端题库与维护</h2></>}
  <button disabled={busy} onClick={()=>void task(async()=>{setCatalog(await fetchCatalog());setMessage('目录已更新')})}>获取云端题库目录</button>
  {catalog.map(b=><div className="cloud-bank" key={b.bank_id}><b>{b.release_name||b.name}</b><span>正式 v{b.release_version} · 修订 {b.revision}</span><button disabled={busy} onClick={()=>void task(async()=>{const changed=await syncDesktop(b.bank_id);await onChanged();setMessage(changed?'题库及版本已同步':'已是最新版本')})}>{banks.some(k=>k.id===b.bank_id)?'检查更新':'下载题库'}</button></div>)}
  <label>维护题库<select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setHistory(null)}}>{[...new Map([...banks.map(b=>({id:b.id,name:b.name})),...(access?.banks||[]).map(b=>({id:b.bank_id,name:b.name}))].map(b=>[b.id,b])).values()].map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
  {!access?.openid?<p className="callout">登录桌面维护者后可创建首版、查看版本和回退题库。</p>:!canMerge?<p className="callout">当前账号没有此题库的合并发布权限。</p>:<button disabled={busy} onClick={()=>void task(refreshHistory)}>读取版本历史</button>}
  {history&&<><p>正式版本 {history.release_version} · 修订 {history.current_revision} · 新上传会直接合并</p>
   {history.current_revision===0&&access?.capabilities?.includes('cloud_bank:create')&&<button disabled={busy||!banks.some(b=>b.id===selected)} onClick={()=>void task(async()=>{
    const questions=await invoke<Question[]>('bank_questions',{bankId:selected});
    if(!window.confirm('将本机「'+(banks.find(b=>b.id===selected)?.name||'')+'」的 '+questions.length+' 道正式题初始化为云端首版？'))return;
    await cloudMutation('/v1/banks/'+selected+'/seed',{base_revision:history.current_revision,questions});await refreshHistory();await syncDesktop(selected);await onChanged();setMessage('云端正式首版已创建');
   })}>从本机正式题初始化首版</button>}
   {!!history.versions.length&&<section className="cloud-history"><h3>版本历史与回退</h3>{history.versions.map(v=><div className="cloud-bank" key={v.revision}><span><b>修订 {v.revision} · 正式 v{v.release_version}</b><small>{v.release_name||'未发布名称'} · {new Date(v.updated_at).toLocaleString()}{v.rollback_of?' · 回退自修订 '+v.rollback_of:''}</small></span><button disabled={busy||v.revision>=history.current_revision} onClick={()=>void task(async()=>{if(!window.confirm('确认将正式题库回退到修订 '+v.revision+'？当前版本会保留为历史记录。'))return;await cloudMutation('/v1/banks/'+selected+'/rollback',{base_revision:history.current_revision,target_revision:v.revision});await refreshHistory();await syncDesktop(selected);await onChanged();setMessage('已创建回退修订')})}>回退到此版本</button></div>)}</section>}
  </>}
  {message&&<p className="callout" role="status">{message}</p>}{busy&&<p>正在处理…</p>}
 </section>;
 return embedded?panel:<div className="modal-backdrop">{panel}</div>;
}
