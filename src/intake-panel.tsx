import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {save} from '@tauri-apps/plugin-dialog';
import {ArrowLeft,Clipboard,Plus,Upload} from 'lucide-react';
import type {Bank} from './types';
import {displayTime,emptyReply,type IntakeMetadata} from '../shared/intake';
import type {DraftRecord} from '../shared/draft';
import type {UploadJob} from '../shared/queue';
import {ModelEditor} from './model-editor';
import {dismissActionMenus} from './dismissible-menus';
import {CloudLogin} from './cloud/login';
import {cloudAccess,enqueueDrafts,desktopJobs,retryDesktopJobs,runDesktopQueue} from './cloud-client';
import {useIntake} from './intake/use-intake';
import {MODEL_PROMPT} from './generated/client-assets';
import './intake/intake.css';
const statuses={queued:'等待上传',uploading:'上传中',retry:'等待自动重试',paused:'需要登录',failed:'需要处理',done:'回执已保存'};
type Props={banks:Bank[];bankId:string;initial?:string;initialRecordId?:string;startManual?:boolean;onClose:()=>void;onSaved:(bankId:string)=>Promise<void>;onBusy:(busy:boolean)=>void};
export function IntakePanel({banks,bankId,initial='',initialRecordId='',startManual=false,onClose,onSaved,onBusy}:Props){
 const [target,setTarget]=useState(bankId||banks[0]?.id||''),[tab,setTab]=useState('edit'),[query,setQuery]=useState(''),[filter,setFilter]=useState('all');
 const [jobs,setJobs]=useState<UploadJob[]>([]),[preparing,setPreparing]=useState(false),[navigating,setNavigating]=useState(false),[login,setLogin]=useState(false),[notice,setNotice]=useState('');
 const trackedUploads=useRef(new Map<string,number>()),notifiedUploads=useRef(new Set<string>()),previousJobStatus=useRef(new Map<string,string>());
 const composing=useRef(false);
 const model=useIntake(target,initial,initialRecordId,startManual),d=model.current;
 const jobFor=(r:DraftRecord)=>jobs.find(j=>j.id===r.submissionId);
 const awaitingUpload=(r:DraftRecord)=>!r.removed&&!r.publishedAt&&(!r.submissionId||jobFor(r)?.status!=='done');
 const pending=model.records.filter(awaitingUpload),uploadable=pending.filter(r=>!r.submissionId),incomplete=uploadable.filter(r=>r.issues.length),locked=!!d.submissionId||preparing||navigating;
 const recordStatus=(r:DraftRecord)=>r.removed?'已删除':r.publishedAt?'已纳入云端首版':r.submissionId?(jobFor(r)?.status==='done'?'已上传 · 已自动合并':'已提交 · '+(jobFor(r)?statuses[jobFor(r)!.status]:'待找回回执')):r.issues.length?'待补全':'待上传';
 async function action(fn:()=>Promise<void>){try{model.setError('');await fn()}catch(e){model.setError(String(e))}}
 async function navigate(fn:()=>Promise<void>){if(navigating||preparing)return;setNavigating(true);try{await action(fn)}finally{setNavigating(false)}}
 const refreshJobs=async()=>{const latest=await desktopJobs();setJobs(latest);for(const job of latest){const count=trackedUploads.current.get(job.id);if(count&&job.status==='done'&&!notifiedUploads.current.has(job.id)){notifiedUploads.current.add(job.id);setNotice(`${count} 题上传成功并已合并到云端，已从待上传列表移除。`);}else if(count&&['failed','paused'].includes(job.status)&&previousJobStatus.current.get(job.id)!==job.status){setNotice(`${count} 题暂未上传成功，仍保留在待处理列表中。`);}previousJobStatus.current.set(job.id,job.status);}return latest;};
 useEffect(()=>{void refreshJobs().catch(e=>model.setError(String(e)));const tick=()=>void refreshJobs().catch(()=>{});window.addEventListener('qbank-upload-change',tick);const t=setInterval(tick,3000);return()=>{clearInterval(t);window.removeEventListener('qbank-upload-change',tick)}},[]);
 async function flush(){await model.flush();}
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key!=='Escape')return;e.preventDefault();e.stopImmediatePropagation();if(dismissActionMenus(document,true))return;if(preparing||navigating)return;if(login){setLogin(false);return;}void navigate(async()=>{await flush();await onSaved(target);onClose()})};window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true)});
 useEffect(()=>{const saveBeforeHide=()=>{void model.flush().catch(()=>{})};window.addEventListener('blur',saveBeforeHide);return()=>window.removeEventListener('blur',saveBeforeHide)},[model.flush]);
 async function upload(){if(preparing||navigating)return;setPreparing(true);onBusy(true);try{await action(async()=>{
  await flush();const items=await model.reload(),selection=items.filter(r=>!r.removed&&!r.publishedAt&&!r.submissionId);
  if(!selection.length)return;
  if(selection.some(r=>r.issues.length)){setTab('records');setFilter('invalid');throw Error('还有待补全题目，请修改或删除后再统一上传。');}
  if(!cloudAccess()){setLogin(true);return;}
  const job=await enqueueDrafts(target,selection.map(r=>({id:r.id,revision:r.revision})));trackedUploads.current.set(job.id,selection.length);await model.reload();const latestJobs=await refreshJobs();await model.next();setTab('edit');if(latestJobs.find(j=>j.id===job.id)?.status!=='done')setNotice(`本批 ${selection.length} 题已提交，上传成功后会自动从待上传列表清除。`);void runDesktopQueue().catch(e=>model.setError(String(e)));
 });}finally{setPreparing(false);onBusy(false);}}
 async function exportFile(){await flush();const path=await save({defaultPath:`${new Date().toISOString().slice(0,10)}_录题.qbank-upload.json`,filters:[{name:'压缩增量包',extensions:['json']}]});if(path){await invoke('draft_export',{bankId:target,path});setNotice('文件已导出；题目仍可编辑，未触发上传。');}}
 const shown=model.records.filter(r=>awaitingUpload(r)&&(!query||r.reply?.stem.includes(query))&&(filter==='all'||filter==='invalid'&&r.issues.length&&!r.submissionId||filter==='pending'&&!r.submissionId));
 const recoverable=jobs.filter(j=>j.bankId===target&&['failed','paused'].includes(j.status));
 return <section className="intake-workspace" aria-label="录题工作区">
  <header className="intake-header"><button aria-label="返回题库" disabled={preparing||navigating} onClick={()=>void navigate(async()=>{await flush();await onSaved(target);onClose()})}><ArrowLeft/>返回</button><div><h2>录入新题</h2><small>自动存本机 · 录完后一次上传</small></div><select aria-label="录入题库" value={target} disabled={!model.ready||preparing||navigating} onChange={e=>{const id=e.target.value;void navigate(async()=>{await flush();setTarget(id)})}}>{banks.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></header>
  <nav className="intake-tabs" aria-label="录题导航">{[['edit','录题'],['records',`待上传 ${pending.length}`]].map(([id,title])=><button key={id} aria-pressed={tab===id} onClick={()=>void navigate(async()=>{await flush();setTab(id)})}>{title}</button>)}</nav>
  <div className="intake-body">
   {!model.ready?<p role="status">读取本地记录…</p>:tab==='edit'?<div className="intake-work-columns">
    <aside className="intake-source-pane"><div className="intake-tools"><button onClick={()=>void action(async()=>{await navigator.clipboard.writeText(MODEL_PROMPT);setNotice('提示词已复制')})}>复制提示词</button><button disabled={locked} onClick={()=>void action(async()=>{const c=await invoke<{text?:string}>('ocr_clipboard');if(!c.text)throw Error('剪贴板没有文字');model.paste(c.text)})}><Clipboard/>粘贴题目</button></div><label>题目原文<textarea aria-label="题目原文" spellCheck={false} value={d.raw} disabled={locked} placeholder="粘贴一道题，右侧自动显示可编辑内容" onCompositionStart={()=>{composing.current=true}} onCompositionEnd={e=>{composing.current=false;model.paste(e.currentTarget.value)}} onChange={e=>composing.current?model.change({raw:e.target.value,sourceIssues:[{field:"raw",message:"原文输入中，完成后自动识别"}]}):model.paste(e.target.value)}/></label><small>原文完整保留，识别不完整也会保存。</small><button disabled={locked} onClick={()=>model.change({reply:emptyReply(),sourceIssues:[]})}><Plus/>手工录题</button>
     {!!d.sourceIssues.length&&<div role="alert" className="intake-issues">{d.sourceIssues.map((i,n)=><p key={n}>{i.message}</p>)}{d.reply&&<button disabled={locked} onClick={()=>model.change({sourceIssues:[]})}>已核对原文，以右侧编辑内容为准</button>}</div>}
    </aside><article className="intake-question-pane">
     {d.reply?<><div className="intake-section-heading"><b>核对题目</b><small>首次录入 {displayTime(d.recordedAt)}</small></div><ModelEditor key={d.id} value={d.reply} disabled={locked} onChange={reply=>model.change({reply})}/><MetadataFields value={d.metadata} disabled={locked} onChange={metadata=>model.change({metadata})}/>{!!d.issues.length&&<div className="intake-issues" role="status">{d.issues.map((i,n)=><p key={n}>{i.message}</p>)}</div>}</>:<div className="intake-empty"><Clipboard/><h3>从一道题开始</h3><p>粘贴后在这里核对题干、选项和答案。每个部分都可以修改。</p></div>}
   </article></div>:<div className="intake-records"><div className="intake-record-toolbar"><input aria-label="搜索待上传题目" placeholder="搜索题目" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="待上传题目类型" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部待处理</option><option value="pending">尚未提交</option><option value="invalid">待补全</option></select></div>{recoverable.length>0&&<div className="intake-upload-recovery"><span>{recoverable.length} 批上传未完成，题目仍保留，可恢复上传。</span><button disabled={preparing||navigating} onClick={()=>void action(async()=>{if(!cloudAccess()){setLogin(true);return;}await retryDesktopJobs(target,true);void runDesktopQueue().catch(e=>model.setError(String(e)));await refreshJobs()})}>恢复上传</button></div>}{!shown.length&&<p className="intake-empty">{pending.length?'当前没有符合筛选条件的待处理题目。':'本批题目已上传，待上传列表已清空。可以继续录入下一道题。'}</p>}{shown.map((r,i)=><article className="intake-record-card" key={r.id}><span className="intake-index">{i+1}</span><div><button className="intake-record-title" onClick={()=>void navigate(async()=>{await model.select(r);setTab('edit')})}>{r.reply?.stem||'未完成的题目'}</button><p>{recordStatus(r)} · {displayTime(r.recordedAt)}</p>{r.issues.length>0&&!r.submissionId&&<small>{r.issues[0].message}</small>}{r.submissionId&&jobFor(r)?.error&&<small>{jobFor(r)?.error}</small>}</div><div className="intake-record-actions"><button disabled={preparing||navigating} onClick={()=>void navigate(async()=>{await model.select(r);setTab('edit')})}>{r.submissionId?'查看':'修改'}</button>{!r.submissionId&&<button className="intake-record-delete" disabled={preparing||navigating} onClick={()=>void navigate(async()=>{await model.remove(r)})}>删除</button>}</div></article>)}<details><summary>导出本地题目</summary><button disabled={preparing||navigating} onClick={()=>void navigate(exportFile)}>导出待上传题目</button><p>导出文件仅用于备份或迁移，上传仍需当前维护者会话。</p></details></div>}
  </div>
  {(model.error||notice)&&<div className={`intake-feedback ${model.error?'error':''}`} role={model.error?'alert':'status'}>{model.error||notice}</div>}
  <footer className="intake-footer"><button className="save-status" onClick={()=>void action(flush)}>{model.saving}</button><span>{pending.length} 题待上传{incomplete.length?` · ${incomplete.length} 题待补全`:''}</span><button disabled={!model.ready||preparing||navigating} onClick={()=>void navigate(async()=>{await flush();await model.next();setTab('edit')})}>下一题</button><button className="primary" disabled={!model.ready||preparing||navigating||!uploadable.length} onClick={()=>void upload()}><Upload/>{preparing?'准备上传…':uploadable.length?`上传 ${uploadable.length} 题`:pending.length?'上传处理中':'上传 0 题'}</button></footer>
  {login&&<div className="modal-backdrop"><section className="modal"><button className="close-modal" onClick={()=>setLogin(false)} aria-label="关闭登录">×</button><h2>上传授权</h2><CloudLogin onChange={()=>{if(cloudAccess()){setLogin(false);setNotice('登录成功，请点击上传确认本次全部题目。')}}}/></section></div>}
 </section>;
}
function MetadataFields({value,disabled,onChange}:{value:IntakeMetadata;disabled:boolean;onChange:(v:IntakeMetadata)=>void}){
 return <details className="intake-metadata"><summary>更多信息 · 章节、标签、难度</summary><fieldset disabled={disabled}>{(['chapter','applicable_version','external_id'] as const).map((key,i)=><label key={key}>{['章节','适用版本','外部编号'][i]}<input value={value[key]} onChange={e=>onChange({...value,[key]:e.target.value})}/></label>)}<label>标签（用 | 分隔）<input value={value.tags.join('|')} onChange={e=>onChange({...value,tags:e.target.value.split('|')})}/></label><label>难度<select value={value.difficulty} onChange={e=>onChange({...value,difficulty:e.target.value as IntakeMetadata['difficulty']})}><option value="">未设置</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label></fieldset></details>;
}
