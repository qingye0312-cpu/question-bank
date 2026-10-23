import './cloud/cloud.css';
import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {cloudAccess,cloudCall,fetchCatalog,syncDesktop,cloudMutation,publishJobs,type PublishJob} from './cloud-client';
import {identityKey,sameAnswer} from '../shared/intake';
import {answerText} from './speed-results';
import {CloudLogin} from './cloud/login';
import type {Bank,Question} from './types';
type Candidate={id:string;question:Question;decision:'pending'|'accepted'|'confirmed';note?:string};
type Version={revision:number;release_version:number;updated_at:string;merged_at?:string|null;release_name?:string|null;release_id?:string|null;rollback_at?:string|null;rollback_of?:number|null;merge_count:number};
type Review={revision:number;release_version:number;candidates:Candidate[];formal:Question[]|null;capacity?:{used_bytes:number;limit_bytes:number};versions?:Version[]};
export function CloudPanel({banks,onChanged,onClose,onBusy}:{banks:Bank[];onChanged:()=>Promise<unknown>;onClose:()=>void;onBusy:(value:boolean)=>void}){
 const [catalog,setCatalog]=useState<{bank_id:string;name:string;revision:number;release_version:number;release_name?:string|null}[]>([]),[selected,setSelected]=useState(banks[0]?.id||''),[review,setReview]=useState<Review|null>(null);
 const [candidate,setCandidate]=useState(''),[edited,setEdited]=useState(''),[note,setNote]=useState(''),[picked,setPicked]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const [operations,setOperations]=useState<PublishJob[]>([]);
 useEffect(()=>{void publishJobs().then(setOperations).catch(()=>{})},[]);
 const roles=cloudAccess()?.grants[selected]||[],current=review?.candidates.find(p=>p.id===candidate);
 const canMerge=roles.includes('merge')||roles.includes('publish'),canCreate=cloudAccess()?.capabilities?.includes('cloud_bank:create');
 let preview=current?.question;let invalid=false;
 try{if(current){const q=JSON.parse(edited) as Question;if(!q||typeof q.stem!=='string'||!Array.isArray(q.options)||q.options.some(o=>!o||typeof o.content!=='string')||!(Array.isArray(q.answer)||typeof q.answer==='boolean'))throw Error();preview=q;}}catch{invalid=true;}
 const matches=preview?(review?.formal||[]).filter(q=>q.question_id===preview.question_id||identityKey(q)===identityKey(preview)):[];
 async function task(action:()=>Promise<void>){if(busy)return;setBusy(true);onBusy(true);setMessage('');try{await action();}catch(e){setMessage(String(e));}finally{setBusy(false);onBusy(false);void publishJobs().then(setOperations).catch(()=>{});}}
 async function refreshReview(){const [r,h]=await Promise.all([cloudCall<Review>(`/v1/banks/${selected}/candidates`,undefined,true),cloudCall<{versions:Version[]}>(`/v1/banks/${selected}/history`,undefined,true)]);setReview({...r,versions:h.versions});setPicked(r.candidates.filter(c=>c.decision==='confirmed'||c.decision==='accepted').map(c=>c.id));setCandidate('');setEdited('');}
 async function decide(decision:'accept'|'reject'){await task(async()=>{const question=decision==='accept'?JSON.parse(edited):undefined;await cloudMutation(`/v1/banks/${selected}/review`,{base_revision:review!.revision,candidate_id:candidate,decision,note,...(decision==='accept'?{question}:{})});await refreshReview();await syncDesktop(selected);await onChanged();setMessage(decision==='accept'?'历史题的确认已保存，可以合并':'已撤回，下次同步将移除此题');});}
 return <div className="modal-backdrop"><section className="modal large cloud-maintenance" role="dialog" aria-modal="true" aria-label="云端题库维护"><button className="close-modal" disabled={busy} onClick={onClose}>×</button><h2>云端题库与维护</h2>
  <CloudLogin disabled={busy} onChange={()=>{render(n=>n+1);setReview(null);}}/>
  <button disabled={busy} onClick={()=>void task(async()=>{setCatalog(await fetchCatalog());setMessage('目录已更新，选择需要安装的题库。');})}>获取云端题库目录</button>
  {catalog.map(b=><div className="cloud-bank" key={b.bank_id}><b>{b.release_name||b.name}</b><span>正式 v{b.release_version} · 修订 {b.revision}</span><button disabled={busy} onClick={()=>void task(async()=>{const changed=await syncDesktop(b.bank_id);await onChanged();setMessage(changed?'题库及版本已同步':'已是最新版本');})}>{banks.some(k=>k.id===b.bank_id)?'检查更新':'下载题库'}</button></div>)}
  <label>维护题库<select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setReview(null);setCandidate('');}}>{[...new Map([...banks.map(b=>({id:b.id,name:b.name})),...(cloudAccess()?.banks||[]).map(b=>({id:b.bank_id,name:b.name}))].map(b=>[b.id,b])).values()].map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
  <button disabled={busy||!roles.some(r=>r==='review'||r==='publish'||r==='merge')} onClick={()=>void task(refreshReview)}>读取版本与历史候选</button>
  {review&&<>{review.capacity&&<p>云端容量 {(review.capacity.used_bytes/1048576).toFixed(2)} / {(review.capacity.limit_bytes/1048576).toFixed(0)} MiB</p>}<p>正式版本 {review.release_version} · 状态修订 {review.revision} · 新上传会立即合并 · 历史候选 {review.candidates.length} 题</p>
   {!!review.versions?.length&&<section className="cloud-history"><h3>版本历史与回退</h3>{review.versions.map(v=><div className="cloud-bank" key={v.revision}><span><b>修订 {v.revision} · 正式 v{v.release_version}</b><small>{v.release_name||'未发布名称'} · {new Date(v.updated_at).toLocaleString()} {v.rollback_of?`· 回退自修订 ${v.rollback_of}`:''}</small></span><button disabled={busy||v.revision>=review.revision||!canMerge} onClick={()=>void task(async()=>{if(!window.confirm(`确认将正式题库回退到修订 ${v.revision}？当前版本会保留为历史记录。`))return;await cloudMutation(`/v1/banks/${selected}/rollback`,{base_revision:review.revision,target_revision:v.revision});await refreshReview();await syncDesktop(selected);await onChanged();setMessage(`已创建回退修订，正式题库恢复到 v${v.release_version}`);})}>回退到此版本</button></div>)}</section>}
   {review.formal===null&&canCreate&&<button disabled={busy||!canMerge||!banks.some(b=>b.id===selected)} onClick={()=>void task(async()=>{
    const questions=await invoke<Question[]>('bank_questions',{bankId:selected});
    if(!window.confirm(`将本机「${banks.find(b=>b.id===selected)?.name}」的 ${questions.length} 道正式题初始化为云端首版？本地录入的新题不计入。`))return;
    await cloudMutation(`/v1/banks/${selected}/seed`,{base_revision:review.revision,questions});await refreshReview();await syncDesktop(selected);await onChanged();setMessage('云端正式首版已创建');
   })}>从本机正式题初始化首版</button>}
   <div className="candidate-list">{review.candidates.map(p=><div key={p.id}><label><input type="checkbox" disabled={busy||!['accepted','confirmed'].includes(p.decision)} checked={picked.includes(p.id)} onChange={e=>setPicked(e.target.checked?[...picked,p.id]:picked.filter(id=>id!==p.id))}/>{p.decision==='confirmed'?'已上传 · 已合并':p.decision==='accepted'?'历史已确认':'历史未确认'}</label><button disabled={busy} onClick={()=>{setCandidate(p.id);setEdited(JSON.stringify(p.question,null,2));setNote(p.note||'');}}>{p.question.stem}</button></div>)}</div>
    {current&&<div className="intake-preview"><h3>{current.decision==='confirmed'?'上传时已合并':'历史题核对'}</h3>{invalid&&<p role="alert">编辑内容尚不是有效题目，无法批准。</p>}<p>候选答案：{answerText(preview!)}</p>{matches.length?matches.map(q=><p key={q.question_id}>正式题答案：{answerText(q)} · {sameAnswer(q,preview!)?'答案一致，可去重':'存在冲突，发布会被阻止'}<br/>{q.options.map(o=>`${o.key}. ${o.content}`).join('；')}</p>):<p>正式题库暂无同题。</p>}
    <label>题目完整内容（可修改题干、选项、答案、解析；保持系统 ID）<textarea rows={16} value={edited} disabled={busy||!roles.includes('review')||current.decision==='confirmed'} onChange={e=>setEdited(e.target.value)}/></label>
    <label>审核说明<input value={note} disabled={busy} onChange={e=>setNote(e.target.value)}/></label><div className="intake-actions">{current.decision!=='confirmed'&&<button disabled={busy||invalid||!note.trim()||!roles.includes('review')} onClick={()=>void decide('accept')}>为历史题补充确认</button>}<button disabled={busy||!note.trim()||(!roles.includes('review')&&!canMerge)} onClick={()=>void decide('reject')}>撤回此题</button></div></div>}
   <button className="primary wide" disabled={busy||!picked.length||!canMerge||review.formal===null} onClick={()=>void task(async()=>{
    if(!window.confirm(`合并所选 ${picked.length} 道已确认题并发布？重复题会去重，冲突会阻止合并；没有新增题时不生成新版本。`))return;
    await cloudMutation(`/v1/banks/${selected}/publish`,{base_revision:review.revision,release_version:review.release_version,candidate_ids:picked});await refreshReview();await syncDesktop(selected);await onChanged();setMessage('历史候选与正式题库已更新；合并结果名称已固定');
   })}>合并所选题目并发布</button>
  </>}
  {operations.filter(j=>j.status!=='done').map(j=><div className="callout" key={j.id}><p>合并任务 {j.id.slice(0,8)} · {j.status==='pending'?'结果待确认':'需要重新核对'} {j.error}</p>{j.status==='pending'&&<button disabled={busy} onClick={()=>void task(async()=>{await cloudMutation(j.path,j.body,j.id);await syncDesktop(j.path.split('/')[3]);await onChanged();setMessage('已找回原合并结果，不会重复发布');})}>重试并找回原结果</button>}</div>)}
  {message&&<p className="callout" role="status">{message}</p>}{busy&&<p>正在处理…</p>}
 </section></div>;
}
