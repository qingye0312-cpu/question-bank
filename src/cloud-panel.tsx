import './cloud/cloud.css';
import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {save} from '@tauri-apps/plugin-dialog';
import {cloudAccess,cloudCall,fetchCatalog,syncDesktop,cloudMutation} from './cloud-client';
import type {CloudManifest} from '../shared/sync';
import type {Bank,Question} from './types';

type Version={revision:number;release_version:number;release_version_label?:string|null;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;merge_count:number;batch_id?:string|null;question_count?:number;added_count?:number;has_incremental_json?:boolean;uploader_account_id?:string|null;uploader_real_name?:string|null;uploader_nickname?:string|null;uploader_auth_type?:'password'|'key'|null};
type History={current_revision:number;release_version:number;versions:Version[]};
type RevisionQuestions={revision:number;batch_id?:string|null;question_count:number;added_count:number;questions:Question[]};

export function CloudPanel({banks,onChanged,onClose,onBusy,embedded=false}:{banks:Bank[];onChanged:()=>Promise<unknown>;onClose:()=>void;onBusy:(value:boolean)=>void;embedded?:boolean}){
 const [catalog,setCatalog]=useState<CloudManifest[]>([]);
 const [selected,setSelected]=useState('');
 const [history,setHistory]=useState<History|null>(null),[historyLoading,setHistoryLoading]=useState(false);
 const [,render]=useState(0);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const initialRefresh=useRef(false);
 const access=cloudAccess(),roles=access?.grants[selected]||[],canMerge=roles.includes('merge');
 const task=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);onBusy(true);setMessage('');try{await fn()}catch(e){setMessage(String(e))}finally{setBusy(false);onBusy(false)}};
 const exportRevision=async(v:Version)=>{await task(async()=>{
  const expected=v.added_count||0;if(!expected)return;
  const result=await cloudCall<RevisionQuestions>(`/v1/banks/${selected}/history/${v.revision}/questions`,undefined,true);
  if(!Array.isArray(result.questions)||result.questions.length!==expected)throw Error('云端没有返回完整的本批次新增题目');
  const bankName=selectedBank?.name||banks.find(bank=>bank.id===selected)?.name||'题库';
  const safeName=bankName.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/\s+/g,'_').replace(/^[_ .-]+|[_ .-]+$/g,'').slice(0,48)||'题库';
  const path=await save({title:'导出修订新增题目',defaultPath:`${safeName}_修订${v.revision}_${v.release_version_label||`v${v.release_version}`}_新增${expected}题.docx`,filters:[{name:'Word 文档',extensions:['docx']}]});
  if(!path)return;
  const count=await invoke<number>('export_remote_questions',{questions:result.questions,path});
  setMessage(`已导出 ${count.toLocaleString()} 道题：${path}`);
 })};
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
 useEffect(()=>{if(initialRefresh.current)return;initialRefresh.current=true;void task(checkUpdates)},[]);
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
   <div className="cloud-catalog-list">
    {catalog.map(b=><div className="cloud-bank cloud-catalog-item" key={b.bank_id}><button type="button" className="cloud-bank-name" disabled={busy} onClick={()=>{setMessage('');setSelected(b.bank_id)}}><b>{b.name}</b>{b.release_name&&<small>{b.release_name}</small>}</button><span className="cloud-catalog-release">正式 v{b.release_version} · 修订 {b.revision}</span>{!banks.some(k=>k.id===b.bank_id)&&<button className="cloud-catalog-download" disabled={busy} onClick={()=>void task(async()=>{await syncDesktop(b.bank_id,b);await onChanged();setMessage('题库已下载')})}>下载题库</button>}</div>)}
    {!catalog.length&&<p className="callout">{busy?'正在读取云端题库目录…':'云端目录暂无题库。'}</p>}
   </div>
   <div className="cloud-catalog-footer"><button className="cloud-refresh-button" disabled={busy} onClick={()=>void task(checkUpdates)}>{busy?'正在检查…':'检查更新'}</button>{message&&<p className="callout cloud-catalog-status" role="status">{message}</p>}</div>
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
   {!!history.versions.length?<section className="cloud-history"><h3>版本历史与回退</h3>{history.versions.map(v=>{const added=v.added_count||0;const label=v.release_version_label||`v${v.release_version}`;const uploader=v.uploader_real_name||v.uploader_nickname||'未记录';return <div className="cloud-bank" key={v.revision}><span><b>修订 {v.revision}</b><small title={v.uploader_account_id?'上传账号 ID：'+v.uploader_account_id:undefined}>上传者：{uploader} · 上传（新增）{added}题 · {new Date(v.updated_at).toLocaleString()}{v.rollback_of?' · 回退自修订 '+v.rollback_of:''} · 正式 {label}</small></span><div className="cloud-history-actions"><button disabled={busy||v.revision>=history.current_revision} onClick={()=>void task(async()=>{if(!window.confirm('确认将正式题库回退到修订 '+v.revision+'？当前版本会保留为历史记录。'))return;await cloudMutation('/v1/banks/'+selected+'/rollback',{base_revision:history.current_revision,target_revision:v.revision});await refreshHistory();await syncDesktop(selected);await onChanged();setMessage('已创建回退修订')})}>回退到此版本</button><button disabled={busy||!v.has_incremental_json||added===0} title={!v.has_incremental_json||added===0?'此修订没有可导出的新增题目记录':undefined} onClick={()=>void exportRevision(v)}>导出此次修订新增题目</button></div></div>})}</section>:<p className="callout">当前暂无可回退的历史版本。</p>}
  </>}
  {selected&&message&&<p className="callout" role="status">{message}</p>}{busy&&<p>正在处理…</p>}
 </section>;
 return embedded?panel:<div className="modal-backdrop">{panel}</div>;
}
