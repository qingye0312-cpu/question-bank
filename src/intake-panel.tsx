import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {save} from '@tauri-apps/plugin-dialog';
import {X,Download,Plus} from 'lucide-react';
import type {Bank,Question} from './types';
import {parseModelReply} from '../shared/intake';
import {PromptTemplate} from './prompt-template';
import {answerText} from './speed-results';
type Comparison={question:Question;status:string;matches:{question:Question;same_answer:boolean;deleted:boolean}[]};
type Batch={id:string;bank_id:string;bank_name:string;created_at:string;count:number;pending:number};
type Entry={question:Question;upload_status:string;uploaded_at:string;exported_at:string};
type Props={banks:Bank[];bankId:string;initial?:string;onClose:()=>void;onSaved:(bankId:string)=>Promise<void>;onBusy:(busy:boolean)=>void};
export function IntakePanel({banks,bankId,initial='',onClose,onSaved,onBusy}:Props){
 const [target,setTarget]=useState(bankId||banks[0]?.id||''),[text,setText]=useState(initial),[result,setResult]=useState<Comparison|null>(null);
 const [batch,setBatch]=useState(''),[batches,setBatches]=useState<Batch[]>([]),[entries,setEntries]=useState<Entry[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),epoch=useRef(0),locked=useRef(false);
 useEffect(()=>()=>{alive.current=false;epoch.current++},[]);
 async function task(action:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);onBusy(true);setError('');try{await action()}catch(e){if(alive.current)setError(String(e))}finally{locked.current=false;onBusy(false);if(alive.current)setBusy(false)}}
 async function reload(id=batch){const all=await invoke<Batch[]>('intake_batches');if(alive.current)setBatches(all);if(id){const rows=await invoke<Entry[]>('intake_entries',{batchId:id});if(alive.current)setEntries(rows)}}
 useEffect(()=>{void reload().catch(e=>setError(String(e)))},[]);
 async function selectBatch(id:string){await task(async()=>{epoch.current++;setResult(null);setBatch(id);setEntries([]);const b=batches.find(b=>b.id===id);if(b)setTarget(b.bank_id);await reload(id)})}
 async function inspect(){await task(async()=>{parseModelReply(text);const request=++epoch.current;const value=await invoke<Comparison>('intake_preview',{bankId:target,text});if(alive.current&&request===epoch.current){setResult(value);setNotice('')}})}
 async function add(){await task(async()=>{const saved=await invoke<{batch_id:string;comparison:Comparison;added:boolean}>('intake_save',{bankId:target,batchId:batch,text});setResult(saved.comparison);
   if(saved.added){setBatch(saved.batch_id);setText('');setResult(null);setNotice('已保存新题 · 待上传。可继续粘贴下一道题，归入同一批次。');await reload(saved.batch_id);await onSaved(target)}
   else setNotice('比对结果已更新，这道题未重复录入。');})}
 async function exportBatch(){await task(async()=>{const name=banks.find(b=>b.id===target)?.name||'题库';const path=await save({defaultPath:`${name.replace(/[\\/:*?"<>|]/g,'_')}_${batch.slice(0,8)}.qbank-delta.json`,filters:[{name:'增量题库',extensions:['json']}]});if(!path)return;
  const n=await invoke<number>('intake_export',{batchId:batch,path});await reload();setNotice(`已保存 ${n} 道新题的增量包。拖入另一台桌面端即可合并；上传标记不变。`)})}
 return <div className="modal-backdrop"><section className="modal intake-modal" role="dialog" aria-modal="true" aria-label="大模型录题与增量包">
  <button className="close-modal" aria-label="关闭录题窗口" disabled={busy} onClick={onClose}><X size={20}/></button>
  <h2>大模型录题</h2><p>复制提示词 → 粘贴模型完整回复 → 核对并保存新题。</p><PromptTemplate/>
  <div className="intake-columns"><div><label>录入题库<select disabled={busy||!!batch} value={target} onChange={e=>{setTarget(e.target.value);setResult(null);epoch.current++}}>{banks.map(b=><option value={b.id} key={b.id}>{b.name}</option>)}</select></label>
   <label>模型回复<textarea rows={11} value={text} disabled={busy} spellCheck={false} placeholder="粘贴 JSON 内容或整个 json 代码块，一次一道题" onChange={e=>{setText(e.target.value);setResult(null);epoch.current++}}/></label>
   <button className="primary wide" disabled={busy||!target||!text.trim()} onClick={inspect}>{busy?'正在处理…':'解析并比对题库'}</button>
   {result&&<div className="intake-preview"><h3>{result.status==='new'?'新题，可以录入':result.status==='conflict'?'已有同题，答案需要核对':result.status==='deleted'?'回收站中已有此题':'题库已收录，答案一致'}</h3>
    <p>{result.question.stem}</p>{result.question.options.map(o=><p key={o.key}>{o.key}. {o.content}</p>)}<strong>模型答案：{answerText(result.question)}</strong><p>{result.question.explanation}</p><small>{result.question.source_note}</small>
    {result.question.issues.map((v,i)=><p className="intake-warning" key={i}>{v}</p>)}
    {result.matches.map(m=><div className="callout" key={m.question.question_id}>已有答案：{answerText(m.question)}{m.deleted?' · 回收站':''}<br/>{m.question.options.map(o=>`${o.key}. ${o.content}`).join('；')}<br/><small>已按选项内容比对；保留现有题目。</small></div>)}
    {result.status==='new'&&<button className="primary wide" disabled={busy} onClick={add}>确认内容并保存新题</button>}
   </div>}
  </div><div><label>录入批次<select value={batch} disabled={busy} onChange={e=>void selectBatch(e.target.value)}><option value="">本次新批次（首道新题保存后建立）</option>{batches.map(b=><option key={b.id} value={b.id}>{new Date(b.created_at).toLocaleString()} · {b.bank_name} · {b.count} 题</option>)}</select></label>
   <div className="intake-actions"><button disabled={busy||!batch} onClick={()=>void selectBatch('')}><Plus size={15}/>新一批</button><button disabled={busy||!entries.length||!batch} onClick={exportBatch}><Download size={15}/>保存增量题库</button></div>
   <p className="intake-message">本批次 {entries.length} 道新题 · 待上传 {entries.filter(e=>e.upload_status==='pending').length} 道。标记仅保存在本机，飞书上传尚未接通。</p>
   <div className="intake-entries">{entries.map(e=><article key={e.question.question_id}><p>{e.question.stem}</p><small>答案：{answerText(e.question)} · {e.upload_status==='pending'?'待上传':'已上传（手动标记）'}{e.exported_at?' · 已导出':''}</small><button disabled={busy} onClick={()=>void task(async()=>{await invoke('intake_mark_upload',{bankId:target,questionId:e.question.question_id,uploaded:e.upload_status==='pending'});await reload()})}>{e.upload_status==='pending'?'标记已上传':'改回待上传'}</button></article>)}{!entries.length&&<div className="callout">新题保存后会列在这里。旧题比对不会加入本批次。</div>}</div>
  </div></div>
  {notice&&<p className="intake-message" role="status">{notice}</p>}{error&&<p className="ocr-error" role="alert">{error}</p>}
 </section></div>
}
