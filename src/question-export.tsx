import React, {useState} from 'react';
import {CalendarDays, Clock3, Download, FileText, X} from 'lucide-react';
import type {Bank} from './types';

type ExportScope='all'|'range';

export function QuestionExport({banks,defaultBankId,busy,onClose,onExport}:{
 banks:Bank[];
 defaultBankId:string;
 busy:boolean;
 onClose:()=>void;
 onExport:(bankId:string,startAt:string|null,endBefore:string|null)=>void;
}){
 const [bankId,setBankId]=useState(defaultBankId);
 const [scope,setScope]=useState<ExportScope>('all');
 const [startDate,setStartDate]=useState('');
 const [startTime,setStartTime]=useState('00:00');
 const [endDate,setEndDate]=useState('');
 const [endTime,setEndTime]=useState('23:59');
 const [confirming,setConfirming]=useState(false);
 const [validation,setValidation]=useState('');
 const selected=banks.find(bank=>bank.id===bankId);

 function reviewExport(){
  setValidation('');
  if(!selected){setValidation('请先选择题库。');return}
  if(scope==='range'){
   if(!startDate||!startTime||!endDate||!endTime){setValidation('请完整选择开始和结束的日期、时间。');return}
   const from=new Date(`${startDate}T${startTime}`),through=new Date(`${endDate}T${endTime}`);
   if(!Number.isFinite(from.getTime())||!Number.isFinite(through.getTime())){setValidation('录入时间格式无效。');return}
   if(from>through){setValidation('开始时间不能晚于结束时间。');return}
  }
  setConfirming(true);
 }

 function confirmExport(){
  if(!selected)return;
  setConfirming(false);
  if(scope==='all'){onExport(bankId,null,null);return}
  const from=new Date(`${startDate}T${startTime}`),through=new Date(`${endDate}T${endTime}`);
  // The selected end minute is inclusive; the backend uses a half-open interval.
  const endExclusive=new Date(through.getTime()+60_000);
  onExport(bankId,from.toISOString(),endExclusive.toISOString());
 }

 return <div className="modal-backdrop intake-hub-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy&&!confirming)onClose()}}>
  <section className="modal question-export-panel" role="dialog" aria-modal="true" aria-labelledby="question-export-title">
   <button className="close-modal" aria-label="关闭题目导出" disabled={busy} onClick={onClose}><X/></button>
   <div className="modal-icon"><FileText/></div>
   <h2 id="question-export-title">导出题目</h2>
   <p className="question-export-intro">按推荐格式导出 DOCX。文件只写入题目、选项、答案和答案解析。</p>
   <label className="question-export-bank-label">选择题库
    <select className="question-export-bank-select" value={bankId} onChange={event=>setBankId(event.target.value)} disabled={busy}>
     <option value="" disabled>请选择题库</option>
     {banks.map(bank=><option key={bank.id} value={bank.id}>{bank.name} · {bank.count.toLocaleString()} 题</option>)}
    </select>
   </label>
   <fieldset className="question-export-scope">
    <legend>导出范围</legend>
    <label className={`question-export-mode ${scope==='all'?'selected':''}`}>
     <input type="radio" name="question-export-scope" checked={scope==='all'} onChange={()=>setScope('all')}/>
     <span className="question-export-mode-copy"><b>全部导出</b><small>导出所选题库的全部题目</small></span>
    </label>
    <label className={`question-export-mode ${scope==='range'?'selected':''}`}>
     <input type="radio" name="question-export-scope" checked={scope==='range'} onChange={()=>setScope('range')}/>
     <span className="question-export-mode-copy"><b>按时间范围</b><small>仅导出所选录入时段内的题目</small></span>
    </label>
   </fieldset>
   {scope==='range'&&<div className="question-export-dates">
    <div className="question-export-dates-heading"><CalendarDays/><span><b>录入时间范围</b><small>开始和结束时间均包含在导出范围内</small></span></div>
    <div className="question-export-date-fields">
     <section className="question-export-date-card" aria-label="开始时间">
      <b className="question-export-date-card-title">开始</b>
      <div className="question-export-date-controls">
       <label><span>日期</span><span className="question-export-input-icon"><CalendarDays/><input aria-label="开始日期" type="date" value={startDate} onChange={event=>setStartDate(event.target.value)} disabled={busy}/></span></label>
       <label><span>时间</span><span className="question-export-input-icon"><Clock3/><input aria-label="开始时间" type="time" step="60" value={startTime} onChange={event=>setStartTime(event.target.value)} disabled={busy}/></span></label>
      </div>
     </section>
     <section className="question-export-date-card" aria-label="结束时间">
      <b className="question-export-date-card-title">结束</b>
      <div className="question-export-date-controls">
       <label><span>日期</span><span className="question-export-input-icon"><CalendarDays/><input aria-label="结束日期" type="date" value={endDate} onChange={event=>setEndDate(event.target.value)} disabled={busy}/></span></label>
       <label><span>时间</span><span className="question-export-input-icon"><Clock3/><input aria-label="结束时间" type="time" step="60" value={endTime} onChange={event=>setEndTime(event.target.value)} disabled={busy}/></span></label>
      </div>
     </section>
    </div>
    <small className="question-export-dates-note">没有录入时间的题目不会包含在时间范围导出中。</small>
   </div>}
   <div className="callout question-export-omissions">不导出题库名称、题号、章节、标签、难度、来源、录入时间等题库信息。选项按模板逐行排列，不在选项间插入空行。</div>
   {validation&&<p className="question-export-error" role="alert">{validation}</p>}
   <button className="primary wide" disabled={busy||!banks.length} onClick={reviewExport}><Download size={17}/>继续</button>
   {confirming&&<div className="question-export-confirm-layer">
    <section className="question-export-confirm" role="alertdialog" aria-modal="true" aria-labelledby="question-export-confirm-title" aria-describedby="question-export-confirm-copy">
     <h3 id="question-export-confirm-title">确认导出题库？</h3>
     <p id="question-export-confirm-copy">当前题库：<b>{selected?.name}</b><br/>{scope==='all'?'将导出该题库的全部题目。':`将导出 ${startDate} ${startTime} 至 ${endDate} ${endTime}（按录入时间筛选）。`}文件仅包含题目、选项、答案和答案解析。</p>
     <div className="question-export-confirm-actions"><button disabled={busy} onClick={()=>setConfirming(false)}>取消</button><button className="primary" disabled={busy} onClick={confirmExport}>确认</button></div>
    </section>
   </div>}
  </section>
 </div>;
}
