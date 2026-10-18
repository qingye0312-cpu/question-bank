import {useEffect,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {cloudAccess,cloudCall,cloudLogin,cloudLogout,cloudOrigin,setCloudOrigin,fetchCatalog,syncDesktop,cloudMutation,publishJobs,type PublishJob,remembersMachine,resumeDesktop,cloudForget} from './cloud-client';
import {identityKey,sameAnswer} from '../shared/intake';
import {answerText} from './speed-results';
import type {Bank,Question} from './types';
type Candidate={id:string;question:Question;decision:'pending'|'accepted'|'confirmed';note?:string};
type Review={revision:number;release_version:number;candidates:Candidate[];formal:Question[]|null};
export function CloudLogin({onChange=()=>{},disabled=false}:{onChange?:()=>void;disabled?:boolean}){
 const [origin,setOrigin]=useState(cloudOrigin),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const [remember,setRemember]=useState(remembersMachine);
 const access=cloudAccess();
 async function login(){if(busy)return;setBusy(true);setMessage('');const secret=key;setKey('');try{if(origin!==cloudOrigin())setCloudOrigin(origin);await cloudLogin(secret,remember);setMessage(remember?'维护者登录成功；已确认任务可自动续取短期会话':'维护者登录成功，仅用于本次会话');render(n=>n+1);onChange();}catch(e){setMessage(String(e));}finally{setBusy(false);}}
 return <div className="cloud-access"><p>日常搜题与本地录题无需登录。开发者上传、维护者合并按题库分别授权。</p>
  <label>云端 HTTPS 地址<input value={origin} disabled={disabled||busy} onChange={e=>setOrigin(e.target.value)}/></label>
  <button disabled={disabled||busy||!origin} onClick={()=>{try{setCloudOrigin(origin);render(n=>n+1);setMessage('地址已保存');onChange();}catch(e){setMessage(String(e));}}}>保存服务地址</button>
  {access?<><p>已授权：{access.banks.map(b=>b.name).join('、')}</p><button disabled={disabled||busy} onClick={()=>{cloudLogout();render(n=>n+1);onChange();}}>退出维护者登录</button></>:<><label><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} disabled={disabled||busy}/>记住本机（系统钥匙串／凭据管理器）</label><label>维护者密钥<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={disabled||busy} onChange={e=>setKey(e.target.value)}/></label><button disabled={disabled||busy||!key} onClick={()=>void login()}>{busy?'正在验证…':'维护者登录'}</button></>}
  {remembersMachine()&&<><button disabled={disabled||busy} onClick={()=>{void resumeDesktop().then(()=>{render(n=>n+1);onChange()}).catch(e=>setMessage(String(e)))}}>使用本机凭据登录</button><button disabled={disabled||busy} onClick={()=>{void cloudForget().then(()=>{setRemember(false);render(n=>n+1)}).catch(e=>setMessage(String(e)))}}>移除本机凭据</button></>}
  {message&&<p role="status">{message}</p>}
 </div>;
}
export function CloudPanel({banks,onChanged,onClose,onBusy}:{banks:Bank[];onChanged:()=>Promise<unknown>;onClose:()=>void;onBusy:(value:boolean)=>void}){
 const [catalog,setCatalog]=useState<{bank_id:string;name:string;revision:number;release_version:number;release_name?:string|null}[]>([]),[selected,setSelected]=useState(banks[0]?.id||''),[review,setReview]=useState<Review|null>(null);
 const [candidate,setCandidate]=useState(''),[edited,setEdited]=useState(''),[note,setNote]=useState(''),[picked,setPicked]=useState<string[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const [operations,setOperations]=useState<PublishJob[]>([]);
 useEffect(()=>{void publishJobs().then(setOperations).catch(()=>{})},[]);
 const roles=cloudAccess()?.grants[selected]||[],current=review?.candidates.find(p=>p.id===candidate);
 const canMerge=roles.includes('merge')||roles.includes('publish');
 let preview=current?.question;let invalid=false;
 try{if(current){const q=JSON.parse(edited) as Question;if(!q||typeof q.stem!=='string'||!Array.isArray(q.options)||q.options.some(o=>!o||typeof o.content!=='string')||!(Array.isArray(q.answer)||typeof q.answer==='boolean'))throw Error();preview=q;}}catch{invalid=true;}
 const matches=preview?(review?.formal||[]).filter(q=>q.question_id===preview.question_id||identityKey(q)===identityKey(preview)):[];
 async function task(action:()=>Promise<void>){if(busy)return;setBusy(true);onBusy(true);setMessage('');try{await action();}catch(e){setMessage(String(e));}finally{setBusy(false);onBusy(false);void publishJobs().then(setOperations).catch(()=>{});}}
 async function refreshReview(){const r=await cloudCall<Review>(`/v1/banks/${selected}/candidates`,undefined,true);setReview(r);setPicked(r.candidates.filter(c=>c.decision==='confirmed'||c.decision==='accepted').map(c=>c.id));setCandidate('');setEdited('');}
 async function decide(decision:'accept'|'reject'){await task(async()=>{const question=decision==='accept'?JSON.parse(edited):undefined;await cloudMutation(`/v1/banks/${selected}/review`,{base_revision:review!.revision,candidate_id:candidate,decision,note,...(decision==='accept'?{question}:{})});await refreshReview();await syncDesktop(selected);await onChanged();setMessage(decision==='accept'?'历史题的确认已保存，可以合并':'已撤回，下次同步将移除此题');});}
 return <div className="modal-backdrop"><section className="modal large cloud-maintenance" role="dialog" aria-modal="true" aria-label="云端题库维护"><button className="close-modal" disabled={busy} onClick={onClose}>×</button><h2>云端题库与维护</h2>
  <CloudLogin disabled={busy} onChange={()=>{render(n=>n+1);setReview(null);}}/>
  <button disabled={busy} onClick={()=>void task(async()=>{setCatalog(await fetchCatalog());setMessage('目录已更新，选择需要安装的题库。');})}>获取云端题库目录</button>
  {catalog.map(b=><div className="cloud-bank" key={b.bank_id}><b>{b.release_name||b.name}</b><span>正式 v{b.release_version} · 修订 {b.revision}</span><button disabled={busy} onClick={()=>void task(async()=>{const changed=await syncDesktop(b.bank_id);await onChanged();setMessage(changed?'题库及待合并题已同步':'已是最新版本');})}>{banks.some(k=>k.id===b.bank_id)?'检查更新':'下载题库'}</button></div>)}
  <label>维护题库<select value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setReview(null);setCandidate('');}}>{[...new Map([...banks.map(b=>({id:b.id,name:b.name})),...(cloudAccess()?.banks||[]).map(b=>({id:b.bank_id,name:b.name}))].map(b=>[b.id,b])).values()].map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
  <button disabled={busy||!roles.some(r=>r==='review'||r==='publish'||r==='merge')} onClick={()=>void task(refreshReview)}>读取待合并题和正式版本</button>
  {review&&<><p>正式版本 {review.release_version} · 状态修订 {review.revision} · 候选 {review.candidates.length} 题</p>
   {review.formal===null&&<button disabled={busy||!canMerge||!banks.some(b=>b.id===selected)} onClick={()=>void task(async()=>{
    const questions=await invoke<Question[]>('bank_questions',{bankId:selected});
    if(!window.confirm(`将本机「${banks.find(b=>b.id===selected)?.name}」的 ${questions.length} 道正式题初始化为云端首版？本地录入的新题不计入。`))return;
    await cloudMutation(`/v1/banks/${selected}/seed`,{base_revision:review.revision,questions});await refreshReview();await syncDesktop(selected);await onChanged();setMessage('云端正式首版已创建');
   })}>从本机正式题初始化首版</button>}
   <div className="candidate-list">{review.candidates.map(p=><div key={p.id}><label><input type="checkbox" disabled={busy||!['accepted','confirmed'].includes(p.decision)} checked={picked.includes(p.id)} onChange={e=>setPicked(e.target.checked?[...picked,p.id]:picked.filter(id=>id!==p.id))}/>{p.decision==='confirmed'?'已上传 · 待合并':p.decision==='accepted'?'历史已确认':'历史未确认'}</label><button disabled={busy} onClick={()=>{setCandidate(p.id);setEdited(JSON.stringify(p.question,null,2));setNote(p.note||'');}}>{p.question.stem}</button></div>)}</div>
   {current&&<div className="intake-preview"><h3>{current.decision==='confirmed'?'上传时已确认':'历史题核对'}</h3>{invalid&&<p role="alert">编辑内容尚不是有效题目，无法批准。</p>}<p>候选答案：{answerText(preview!)}</p>{matches.length?matches.map(q=><p key={q.question_id}>正式题答案：{answerText(q)} · {sameAnswer(q,preview!)?'答案一致，可去重':'存在冲突，发布会被阻止'}<br/>{q.options.map(o=>`${o.key}. ${o.content}`).join('；')}</p>):<p>正式题库暂无同题。</p>}
    <label>题目完整内容（可修改题干、选项、答案、解析；保持系统 ID）<textarea rows={16} value={edited} disabled={busy||!roles.includes('review')||current.decision==='confirmed'} onChange={e=>setEdited(e.target.value)}/></label>
    <label>审核说明<input value={note} disabled={busy} onChange={e=>setNote(e.target.value)}/></label><div className="intake-actions">{current.decision!=='confirmed'&&<button disabled={busy||invalid||!note.trim()||!roles.includes('review')} onClick={()=>void decide('accept')}>为历史题补充确认</button>}<button disabled={busy||!note.trim()||(!roles.includes('review')&&!canMerge)} onClick={()=>void decide('reject')}>撤回此题</button></div></div>}
   <button className="primary wide" disabled={busy||!picked.length||!canMerge||review.formal===null} onClick={()=>void task(async()=>{
    if(!window.confirm(`合并所选 ${picked.length} 道已确认题并发布？重复题会去重，冲突会阻止合并；没有新增题时不生成新版本。`))return;
    await cloudMutation(`/v1/banks/${selected}/publish`,{base_revision:review.revision,release_version:review.release_version,candidate_ids:picked});await refreshReview();await syncDesktop(selected);await onChanged();setMessage('正式题与待合并列表已一起更新；合并结果名称已固定');
   })}>合并所选题目并发布</button>
  </>}
  {operations.filter(j=>j.status!=='done').map(j=><div className="callout" key={j.id}><p>合并任务 {j.id.slice(0,8)} · {j.status==='pending'?'结果待确认':'需要重新核对'} {j.error}</p>{j.status==='pending'&&<button disabled={busy} onClick={()=>void task(async()=>{await cloudMutation(j.path,j.body,j.id);await syncDesktop(j.path.split('/')[3]);await onChanged();setMessage('已找回原合并结果，不会重复发布');})}>重试并找回原结果</button>}</div>)}
  {message&&<p className="callout" role="status">{message}</p>}{busy&&<p>正在处理…</p>}
 </section></div>;
}
