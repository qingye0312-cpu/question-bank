import './cloud/cloud.css';
import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {save} from '@tauri-apps/plugin-dialog';
import {cloudAccess,cloudCall,fetchCatalog,syncDesktop,cloudMutation} from './cloud-client';
import type {CloudManifest} from '../shared/sync';
import type {Bank,Question} from './types';

type Version={revision:number;formal_revision?:string;release_version:number;release_version_label?:string|null;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;rollback_to_release_version_label?:string|null;merge_count:number;batch_id?:string|null;question_count?:number;added_count?:number;has_incremental_json?:boolean;has_revision_questions?:boolean;uploader_account_id?:string|null;uploader_real_name?:string|null;uploader_nickname?:string|null;uploader_auth_type?:'password'|'key'|null};
type History={current_revision:number;current_formal_revision?:string;release_version:number;release_version_label?:string|null;versions:Version[]};
type RevisionQuestions={revision:number;batch_id?:string|null;question_count:number;added_count:number;questions:Question[]};
const displayUploader=(...values:Array<string|null|undefined>)=>values.map(value=>value?.trim()).find(value=>value&&value!=='未记录')||'star';

export function CloudPanel({banks,onChanged,onClose,onBusy,embedded=false}:{banks:Bank[];onChanged:()=>Promise<unknown>;onClose:()=>void;onBusy:(value:boolean)=>void;embedded?:boolean}){
 const [catalog,setCatalog]=useState<CloudManifest[]>([]);
 const [selected,setSelected]=useState('');
 const [history,setHistory]=useState<History|null>(null),[historyLoading,setHistoryLoading]=useState(false);
 const [detailsOpen,setDetailsOpen]=useState(false),[details,setDetails]=useState<Record<number,RevisionQuestions>>({}),[detailsLoading,setDetailsLoading]=useState<number|null>(null);
 const [,render]=useState(0);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const initialRefresh=useRef(false);
 const access=cloudAccess(),roles=access?.grants[selected]||[],canMerge=!!access?.capabilities?.includes('maintainer:manage')||roles.includes('merge');
 const task=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);onBusy(true);setMessage('');try{await fn()}catch(e){setMessage(String(e))}finally{setBusy(false);onBusy(false)}};
 const exportRevision=async(v:Version)=>{await task(async()=>{
  const expected=v.added_count||0;if(!expected)return;
  const result=await cloudCall<RevisionQuestions>(`/v1/banks/${selected}/history/${v.revision}/questions`,undefined,true);
  if(!Array.isArray(result.questions)||result.questions.length!==expected)throw Error('云端没有返回完整的本批次新增题目');
  const bankName=selectedBank?.name||banks.find(bank=>bank.id===selected)?.name||'题库';
  const safeName=bankName.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/\s+/g,'_').replace(/^[_ .-]+|[_ .-]+$/g,'').slice(0,48)||'题库';
  const displayRevision=String(v.revision);
  const path=await save({title:'导出修订新增题目',defaultPath:`${safeName}_修订${displayRevision}_${v.release_version_label||`v${v.release_version}`}_新增${expected}题.docx`,filters:[{name:'Word 文档',extensions:['docx']}]});
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
  let active=true;setHistory(null);setHistoryLoading(false);setDetailsOpen(false);setDetails({});setDetailsLoading(null);
  if(selected&&canMerge){setHistoryLoading(true);void cloudCall<History>('/v1/banks/'+selected+'/history',undefined,true).then(value=>{if(active)setHistory(value)}).catch(error=>{if(active)setMessage(String(error))}).finally(()=>{if(active)setHistoryLoading(false)});}
  return ()=>{active=false};
 },[selected,access?.openid,canMerge]);
 const selectedBank=catalog.find(bank=>bank.bank_id===selected);
 const returnToCatalog=()=>{setSelected('');setHistory(null);setMessage('')};
 const loadRevisionDetails=async(v:Version)=>{if(details[v.revision]||detailsLoading===v.revision)return;setDetailsLoading(v.revision);setMessage('');try{const result=await cloudCall<RevisionQuestions>(`/v1/banks/${selected}/history/${v.revision}/questions`,undefined,true);setDetails(current=>({...current,[v.revision]:result}));}catch(e){setMessage(String(e))}finally{setDetailsLoading(current=>current===v.revision?null:current)}};
 const panel=<section className={embedded?'cloud-maintenance cloud-maintenance-embedded':'modal large cloud-maintenance'} role={embedded?'region':'dialog'} aria-label="云端题库维护">
  {!embedded&&<><button className="close-modal" disabled={busy} onClick={onClose}>×</button><h2>云端题库与维护</h2></>}
  {!selected?<>
   <div className="cloud-catalog-list">
    {catalog.map(b=><div className="cloud-bank cloud-catalog-item" key={b.bank_id}><button type="button" className="cloud-bank-name" disabled={busy} onClick={()=>{setMessage('');setSelected(b.bank_id)}}><b>{b.name}</b>{b.release_name&&<small>{b.release_name}</small>}</button><span className="cloud-catalog-release">正式 {b.release_version_label||`v${b.release_version}`} · 修订 {b.revision}</span>{!banks.some(k=>k.id===b.bank_id)&&<button className="cloud-catalog-download" disabled={busy} onClick={()=>void task(async()=>{await syncDesktop(b.bank_id,b);await onChanged();setMessage('题库已下载')})}>下载题库</button>}</div>)}
    {!catalog.length&&<p className="callout">{busy?'正在读取云端题库目录…':'云端目录暂无题库。'}</p>}
   </div>
   <div className="cloud-catalog-footer"><button className="cloud-refresh-button" disabled={busy} onClick={()=>void task(checkUpdates)}>{busy?'正在检查…':'检查更新'}</button>{message&&<p className="callout cloud-catalog-status" role="status">{message}</p>}</div>
  </>:<>
   <div className="cloud-history-bank-header">
    <button type="button" className="cloud-history-back-button" disabled={busy} onClick={returnToCatalog}><span aria-hidden="true">←</span><span>返回</span></button>
    <div className="cloud-history-bank-copy"><h3>{selectedBank?.name||'题库历史版本'}</h3>{history&&<p className="cloud-history-summary">正式版本 {history.release_version_label||`v${history.release_version}`} · 修订 {history.current_revision} · 新上传会直接合并</p>}</div>
   </div>
   {!canMerge?<p className="callout">当前账号没有此题库的版本历史查看权限。</p>:historyLoading?<p>正在读取历史版本…</p>:null}
  </>}
  {selected&&history&&<>
   {history.current_revision===0&&access?.capabilities?.includes('cloud_bank:create')&&<button disabled={busy||!banks.some(b=>b.id===selected)} onClick={()=>void task(async()=>{
    const questions=await invoke<Question[]>('bank_questions',{bankId:selected});
    if(!window.confirm('将本机「'+(banks.find(b=>b.id===selected)?.name||'')+'」的 '+questions.length+' 道正式题初始化为云端首版？'))return;
    await cloudMutation('/v1/banks/'+selected+'/seed',{base_revision:history.current_revision,questions});await refreshHistory();await syncDesktop(selected);await onChanged();setMessage('云端正式首版已创建');
   })}>从本机正式题初始化首版</button>}
  {!!history.versions.length?(detailsOpen?<section className="cloud-history-details"><div className="cloud-history-details-heading"><div><h3>详细修订变更</h3><p>按修订查看当前正式题库中的新增题目。</p></div><button type="button" disabled={busy} onClick={()=>setDetailsOpen(false)}>返回版本历史</button></div><div className="cloud-history-details-list">{[...history.versions].sort((left,right)=>right.revision-left.revision).map(v=>{const added=v.added_count||0,label=v.release_version_label||`v${v.release_version}`,displayRevision=String(v.revision),uploader=displayUploader(v.uploader_real_name,v.uploader_nickname),detail=details[v.revision],loading=detailsLoading===v.revision;return <article className="cloud-history-details-item" key={v.revision}><button type="button" className="cloud-history-details-toggle" disabled={busy||loading} onClick={()=>void loadRevisionDetails(v)}><span><b>修订 {displayRevision}</b><em>{label}</em></span><span>{loading?'正在读取…':detail?`${detail.questions.length.toLocaleString()} 题`:`新增 ${added.toLocaleString()} 题`}</span></button><div className="cloud-history-details-meta"><span>上传者 {uploader}</span><time dateTime={v.updated_at}>{new Date(v.updated_at).toLocaleString()}</time></div>{detail&&<div className="cloud-history-question-list">{detail.questions.length?<ol>{detail.questions.map(question=><li key={question.question_id}><strong>{question.external_id||question.question_id}</strong><p>{question.stem}</p></li>)}</ol>:<p>该修订没有新增题目。</p>}</div>}</article>})}</div></section>:<section className="cloud-history"><div className="cloud-history-heading"><h3>版本历史与回退</h3><div className="cloud-history-heading-actions"><button type="button" disabled={busy} onClick={()=>setDetailsOpen(true)}>查看详细修订变更</button><span>最新修订在前</span></div></div>{[...history.versions].sort((left,right)=>right.revision-left.revision).map(v=>{const added=v.added_count||0;const label=v.release_version_label||`v${v.release_version}`,displayRevision=String(v.revision),uploader=displayUploader(v.uploader_real_name,v.uploader_nickname);const canExport=!!(v.has_revision_questions??v.has_incremental_json)&&added>0;return <article className="cloud-history-item" key={v.revision}><div className="cloud-history-main"><div className="cloud-history-title"><b>修订 {displayRevision}</b><span className="cloud-history-release">{label}</span>{v.rollback_to_release_version_label&&<span className="cloud-history-rollback">回退到正式版 {v.rollback_to_release_version_label}</span>}</div><div className="cloud-history-meta"><span>上传者 <strong title={v.uploader_account_id?'上传账号 ID：'+v.uploader_account_id:undefined}>{uploader}</strong></span><span>新增 <strong>{added.toLocaleString()} 题</strong></span><time dateTime={v.updated_at}>{new Date(v.updated_at).toLocaleString()}</time></div></div><div className="cloud-history-actions"><button disabled={busy||v.revision>=history.current_revision} onClick={()=>void task(async()=>{if(!window.confirm('确认将正式题库回退到修订 '+displayRevision+'？当前版本会保留为历史记录。'))return;await cloudMutation('/v1/banks/'+selected+'/rollback',{base_revision:history.current_revision,target_revision:v.revision});await refreshHistory();await syncDesktop(selected);await onChanged();setMessage('已创建回退修订')})}>回退到此版本</button><button disabled={busy||!canExport} title={!canExport?'此修订没有可导出的新增题目记录':undefined} onClick={()=>void exportRevision(v)}>导出此次修订新增题目</button></div></article>})}</section>):<p className="callout">当前暂无可回退的历史版本。</p>}
  </>}
  {selected&&message&&<p className="callout" role="status">{message}</p>}{busy&&<p>正在处理…</p>}
 </section>;
 return embedded?panel:<div className="modal-backdrop">{panel}</div>;
}
