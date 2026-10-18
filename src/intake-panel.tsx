import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {save} from '@tauri-apps/plugin-dialog';
import {X} from 'lucide-react';
import type {Bank,Question} from './types';
import {parseModelReply,parseDraft,emptyReply,editedReplyText,intakeMetadata,replyFromQuestion,recordedTime,displayTime,resultName,sha256,type ModelReply,type IntakeQuestion,type IntakeMetadata} from '../shared/intake';
import {ModelEditor} from './model-editor';
import {CloudLogin} from './cloud-panel';
import {enqueueDesktop,desktopJobs,retryDesktopJobs,runDesktopQueue,syncDesktop} from './cloud-client';
import type {UploadJob} from '../shared/queue';
import {PromptTemplate} from './prompt-template';
import {answerText} from './speed-results';
type Batch={id:string;bank_id:string;bank_name:string;created_at:string;count:number;pending:number};
type Entry={batchId?:string;question:Question;upload_status:string;review_status:string;uploaded_at:string;exported_at:string};
type Draft={text:string;reply:ModelReply|null;original:string;metadata:IntakeMetadata;editing:string;recordedAt:string|null;batch:string};
const blank=():Draft=>({text:'',reply:null,original:'',metadata:intakeMetadata(),editing:'',recordedAt:null,batch:''});
type Props={banks:Bank[];bankId:string;initial?:string;onClose:()=>void;onSaved:(bankId:string)=>Promise<void>;onBusy:(busy:boolean)=>void};
export function IntakePanel({banks,bankId,initial='',onClose,onSaved,onBusy}:Props){
 const [target,setTarget]=useState(bankId||banks[0]?.id||''),[d,setD]=useState<Draft>(blank),[previous,setPrevious]=useState<Draft|null>(null);
 const [readyBank,setReadyBank]=useState(''),[batches,setBatches]=useState<Batch[]>([]),[entries,setEntries]=useState<Entry[]>([]),[jobs,setJobs]=useState<UploadJob[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[saved,setSaved]=useState('');
 const parseTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),composing=useRef(false),epoch=useRef(0),writes=useRef<Promise<unknown>>(Promise.resolve()),locked=useRef(false);
 const ready=readyBank===target,initialUsed=useRef(false),manualEdit=useRef(false);
 const [review,setReview]=useState<{bank:string;entries:Entry[];signature:string}|null>(null);
 const current=useRef(d);current.current=d;const targetRef=useRef(target);targetRef.current=target;
 async function task(action:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);onBusy(true);setError('');try{await action()}catch(e){setError(String(e))}finally{locked.current=false;setBusy(false);onBusy(false)}}
 const cancelParse=()=>{clearTimeout(parseTimer.current);epoch.current++;};
 async function reload(_id=current.current.batch){const all=(await invoke<Batch[]>('intake_batches')).filter(b=>b.count);const queue=await desktopJobs();setBatches(all);setJobs(queue);const pending=(await Promise.all(all.filter(b=>b.bank_id===target&&b.pending>0).map(async b=>(await invoke<Entry[]>('intake_entries',{batchId:b.id})).filter(e=>e.upload_status!=='uploaded').map(e=>({...e,batchId:b.id}))))).flat();if(targetRef.current!==target)return;setEntries(pending);const jobsHere=queue.filter(j=>j.bankId===target);if(jobsHere.length&&jobsHere.every(j=>j.status==='done')&&!pending.length)setNotice('本次已全部上传，回执已保存，可以关闭。');}

 useEffect(()=>{let alive=true;setReadyBank('');cancelParse();void invoke<{draft:Draft;previous:Draft|null}|null>('client_state',{key:`draft:${target}`,value:null}).then(v=>{if(alive){let next=v?.draft||blank();if(initial&&!initialUsed.current&&target===(bankId||banks[0]?.id)){initialUsed.current=true;try{next={...next,text:initial,original:initial,reply:parseDraft(initial)}}catch{next={...next,text:initial}}}setD(next);setPrevious(v?.previous||null);setReadyBank(target);void reload(next.batch);}}).catch(e=>setError(String(e)));return()=>{alive=false;cancelParse();}},[target]);
 useEffect(()=>{if(!ready)return;let alive=true;setSaved('保存草稿…');const value={draft:d,previous};writes.current=writes.current.catch(()=>{}).then(()=>invoke('client_state',{key:`draft:${target}`,value}));void writes.current.then(()=>{if(alive)setSaved('草稿已保存到本机')},e=>{if(alive){setSaved('草稿保存失败');setError(String(e))}});return()=>{alive=false}},[d,previous,target,ready]);
 useEffect(()=>{const update=()=>void reload().catch(e=>setError(String(e)));window.addEventListener('qbank-upload-change',update);return()=>window.removeEventListener('qbank-upload-change',update)},[target]);
 function recognize(raw:string){cancelParse();try{const reply=parseDraft(raw);setD(v=>({...v,reply,original:raw,editing:'',recordedAt:null}));setError('')}catch(e){setD(v=>({...v,reply:null,original:raw,editing:'',recordedAt:null}));setError(String(e))}}
 function rawChanged(raw:string){if(manualEdit.current){setPrevious(d);manualEdit.current=false;}cancelParse();setD(v=>({...v,text:raw}));if(!composing.current){const token=epoch.current;parseTimer.current=setTimeout(()=>{if(token===epoch.current)recognize(raw)},300)}}
 function paste(raw:string){cancelParse();if(d.text||d.reply)setPrevious(d);setD(v=>({...blank(),metadata:v.metadata,batch:v.batch,text:raw}));recognize(raw)}
 function changeReply(reply:ModelReply){manualEdit.current=true;cancelParse();setD(v=>({...v,reply}));setNotice('修改只保存在本机，录完后统一上传。')}
 async function add(){await task(async()=>{cancelParse();if(!d.reply)throw Error('请先粘贴或手工录入题目');const text=editedReplyText(d.reply,d.original);parseModelReply(text);let batch=d.batch;
  if(d.editing){await invoke('intake_edit',{bankId:target,questionId:d.editing,text,metadata:intakeMetadata(d.metadata)});setNotice('修改已保存，录入时间保持不变。');}
  else {const r=await invoke<{batch_id:string;added:boolean;comparison:{status:string}}>('intake_save',{bankId:target,batchId:d.batch,text,metadata:intakeMetadata(d.metadata)});if(!r.added)throw Error(r.comparison.status==='conflict'?'同题答案有冲突，未覆盖现有题目':'已有同题，未重复录入');batch=r.batch_id;setNotice('本题已存本地。继续录入，全部完成后再统一上传。');}
  setD({...blank(),batch,metadata:{...d.metadata,external_id:''}});await reload(batch);await onSaved(target);
 })}
 async function upload(confirmed=false){await task(async()=>{if(d.reply||d.text)throw Error('当前题目还在编辑，请先保存本题，或恢复后清空草稿');
  const pending=batches.filter(b=>b.bank_id===target&&b.pending>0&&!jobs.some(j=>j.id===b.id));if(!pending.length){await retryDesktopJobs(target);await runDesktopQueue();return;}
  const all=(await Promise.all(pending.map(b=>invoke<Entry[]>('intake_entries',{batchId:b.id})))).flat();
  const signature=JSON.stringify(all.map(e=>e.question));
  if(!confirmed||!review||review.bank!==target||review.signature!==signature){setReview({bank:target,entries:all,signature});if(confirmed)setNotice('题目有变化，请重新检查完整批次。');return;}
  await enqueueDesktop(pending.map(b=>b.id),target);setReview(null);setNotice('整批任务已保存，正在上传；关闭窗口后会继续，退出软件后下次恢复。');await runDesktopQueue();await reload();await onSaved(target);
 })}
 async function exportBatch(){await task(async()=>{const b=batches.find(b=>b.id===d.batch);if(!b)return;const t=await invoke<{raw:string}>('cloud_transfer',{batchId:d.batch,endpoint:''});const name=resultName(b.created_at,b.bank_name,'增量','b'+b.id.slice(0,8),b.bank_id,sha256(t.raw));const path=await save({defaultPath:name+'.qbank-upload.json',filters:[{name:'增量题库',extensions:['json']}]});if(path){await invoke('intake_export',{batchId:d.batch,path});setNotice('已导出压缩增量包，未触发上传。');await reload()}})}
 function edit(e:Entry){cancelParse();if(d.reply||d.text)setPrevious(d);const q=e.question;setD({...d,batch:e.batchId||d.batch,text:'',original:JSON.stringify(replyFromQuestion(q as IntakeQuestion)),reply:replyFromQuestion(q as IntakeQuestion),metadata:intakeMetadata({chapter:q.chapter,tags:q.tags,difficulty:q.difficulty as IntakeMetadata['difficulty'],applicable_version:q.applicable_version,external_id:q.external_id}),editing:q.question_id,recordedAt:recordedTime(q)});}
 return <div className="modal-backdrop"><section className="modal intake-modal" role="dialog" aria-modal="true" aria-label="连续录题">
  <button className="close-modal" aria-label="关闭录题窗口" disabled={busy} onClick={()=>void task(async()=>{await writes.current;onClose()})}><X size={20}/></button>
  <h2>连续录题</h2><p>粘贴后直接核对右侧，圆点标记正确答案。先录完多题，再统一上传。</p>
  <label>录入题库<select value={target} disabled={busy||!ready} onChange={e=>{const id=e.target.value;void task(async()=>{await writes.current;setTarget(id);setReview(null);setEntries([])})}}>{banks.map(b=><option key={b.id} value={b.id}>{b.release_name||b.name}</option>)}</select></label>
  <div className="intake-columns"><div className="intake-source"><PromptTemplate/>
   <button disabled={busy||!ready} onClick={()=>void task(async()=>{const c=await invoke<{text?:string}>('ocr_clipboard');if(!c.text)throw Error('剪贴板没有文字');paste(c.text)})}>粘贴题目</button>
   <label>模型原文<textarea rows={18} value={d.text} disabled={busy||!ready} spellCheck={false} placeholder="粘贴一道 JSON 题目，右侧会自动显示" onPaste={()=>{if(d.reply)setPrevious(d)}} onChange={e=>rawChanged(e.target.value)} onCompositionStart={()=>{composing.current=true;cancelParse()}} onCompositionEnd={e=>{composing.current=false;rawChanged(e.currentTarget.value)}}/></label>
   <button disabled={busy} onClick={()=>{if(d.reply||d.text)setPrevious(d);cancelParse();setD({...blank(),batch:d.batch,reply:emptyReply()})}}>手工录题</button>
   {previous&&<button disabled={busy} onClick={()=>{cancelParse();setPrevious(d);setD(previous)}}>恢复上一份草稿</button>}
   <p role="status">{saved}</p>
  </div><div className="intake-editor">
   {d.reply?<><p>录入时间：{d.editing?displayTime(d.recordedAt):'首次保存本题时记录'}</p><ModelEditor value={d.reply} disabled={busy} onChange={changeReply}/>
    <details><summary>更多信息</summary><fieldset disabled={busy} className="model-editor">{(['chapter','applicable_version','external_id'] as const).map((k,i)=><label key={k}>{['章节','适用版本','外部编号'][i]}<input value={d.metadata[k]} onChange={e=>setD({...d,metadata:{...d.metadata,[k]:e.target.value}})}/></label>)}
     <label>标签（| 分隔）<input value={d.metadata.tags.join('|')} onChange={e=>setD({...d,metadata:{...d.metadata,tags:e.target.value.split('|')}})}/></label><label>难度<select value={d.metadata.difficulty} onChange={e=>setD({...d,metadata:{...d.metadata,difficulty:e.target.value as IntakeMetadata['difficulty']}})}><option value="">未设置</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label>
    </fieldset></details><button className="primary wide" disabled={busy} onClick={()=>void add()}>{d.editing?'保存修改':'保存本题，继续下一题'}</button><button disabled={busy} onClick={()=>{setPrevious(d);cancelParse();setD({...blank(),batch:d.batch,metadata:d.metadata})}}>收起当前草稿，查看整批</button>
   </>:<div className="callout">在左侧粘贴题目，或选择手工录题。缺少答案也可先编辑，补全后才能保存。</div>}
  </div></div>
  <section className="intake-batch"><h3>待上传 · {entries.length} 题</h3><p>这里汇总当前题库全部未上传新题。可以继续录入，全部核实后统一上传。</p>
   <div className="intake-entries">{entries.map((e,i)=><article key={e.question.question_id}><details><summary>{i+1}. {e.question.stem}</summary>{e.question.options.map(o=><p key={o.key}>{o.key}. {o.content}</p>)}<p>解析：{e.question.explanation}</p></details><small>答案：{answerText(e.question)} · 录入：{displayTime(recordedTime(e.question))}</small><small>待上传{jobs.some(j=>j.id===e.batchId)?' · 已确认，正在等待回执':''}</small><button disabled={busy||!!e.exported_at||jobs.some(j=>j.id===e.batchId)} onClick={()=>edit(e)}>编辑本题</button></article>)}</div>
   <details><summary>增量文件与历史记录</summary><label>导出记录<select value={d.batch} disabled={busy} onChange={e=>setD({...d,batch:e.target.value})}><option value="">当前新录入</option>{batches.filter(b=>b.bank_id===target).map(b=><option key={b.id} value={b.id}>{displayTime(b.created_at)} · {b.count} 题</option>)}</select></label><button disabled={busy||!d.batch} onClick={()=>void exportBatch()}>导出所选增量文件</button></details>
   <details><summary>开发者登录与云端任务</summary><CloudLogin disabled={busy} onChange={()=>{void retryDesktopJobs(target).then(runDesktopQueue).catch(e=>setError(String(e)))}}/>
    {jobs.filter(j=>j.bankId===target).map(j=><p key={j.id}>{j.id.slice(0,8)} · {{queued:'等待上传',uploading:'上传中',retry:'等待自动重试',paused:'需要重新登录',failed:'需要处理',done:'回执已保存'}[j.status]} {j.error}</p>)}
    <button disabled={busy} onClick={()=>void task(async()=>{await retryDesktopJobs(target);await runDesktopQueue();await syncDesktop(target);await reload();await onSaved(target)})}>恢复已确认任务并更新状态</button>
   </details><button className="primary wide" disabled={busy||!batches.some(b=>b.bank_id===target&&b.pending)} onClick={()=>void upload()}>这一批录完了，统一上传</button>
   {review&&review.bank===target&&<section className="batch-confirm"><h3>上传前核实全部 {review.entries.length} 题</h3><p>逐题检查以下内容，确认后统一上传并进入待合并。</p>{review.entries.map((e,i)=><article key={e.question.question_id}><b>{i+1}. {e.question.stem}</b>{e.question.options.map(o=><p key={o.key}>{o.key}. {o.content}</p>)}<p>正确答案：{answerText(e.question)}</p><p>解析：{e.question.explanation}</p><small>录入：{displayTime(recordedTime(e.question))}</small></article>)}<div className="intake-actions"><button disabled={busy} onClick={()=>setReview(null)}>返回修改</button><button className="primary" disabled={busy} onClick={()=>void upload(true)}>已核实，确认上传这 {review.entries.length} 题</button></div></section>}
  </section>{notice&&<p className="intake-message" role="status">{notice}</p>}{error&&<p className="ocr-error" role="alert">{error}</p>}
 </section></div>;
}
