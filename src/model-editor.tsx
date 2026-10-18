import {useLayoutEffect,useRef} from 'react';
import {changeQuestionType,reorderOptions,toggleAnswer,type ModelReply} from '../shared/intake';
export function ModelEditor({value:r,onChange,disabled=false}:{value:ModelReply;onChange:(r:ModelReply)=>void;disabled?:boolean}){
 const editor=useRef<HTMLFieldSetElement>(null);
 useLayoutEffect(()=>{editor.current?.querySelectorAll('textarea').forEach(el=>{el.style.height='auto';el.style.height=`${Math.max(72,el.scrollHeight)}px`;});},[r]);
 const set=(patch:Partial<ModelReply>)=>onChange({...r,...patch});
 const move=(from:number,to:number)=>{const order=r.options.map((_,i)=>i);[order[from],order[to]]=[order[to],order[from]];onChange(reorderOptions(r,order));};
 return <fieldset ref={editor} disabled={disabled} className="model-editor">
  <label>题型<select value={r.type} onChange={e=>onChange(changeQuestionType(r,e.target.value as ModelReply['type']))}><option value="single">单选</option><option value="multiple">多选</option><option value="true_false">判断</option></select></label>
  <label>题干<textarea value={r.stem} onChange={e=>set({stem:e.target.value})}/></label>
  {r.options.map((o,i)=><div key={o.key} className={`editable-option ${Array.isArray(r.answer)&&r.answer.includes(o.key)?'answer-selected':''}`}><button type="button" className="answer-dot" aria-label={`${o.key} 正确答案`} aria-pressed={Array.isArray(r.answer)&&r.answer.includes(o.key)} onClick={()=>onChange(toggleAnswer(r,o.key))}>{Array.isArray(r.answer)&&r.answer.includes(o.key)?'●':'○'}</button><label>{o.key}<textarea value={o.content} onChange={e=>set({options:r.options.map((v,n)=>i===n?{...v,content:e.target.value}:v)})}/></label>
   <div className="intake-actions"><button type="button" disabled={i===0} onClick={()=>move(i,i-1)}>上移</button><button type="button" disabled={i===r.options.length-1} onClick={()=>move(i,i+1)}>下移</button><button type="button" disabled={r.options.length<=2} onClick={()=>onChange(reorderOptions(r,r.options.map((_,n)=>n).filter(n=>n!==i)))}>删除</button></div></div>)}
  {r.type==='true_false'?<div className="judgment-answers">{[true,false].map(v=><button key={String(v)} type="button" className={r.answer===v?'answer-selected':''} aria-pressed={r.answer===v} onClick={()=>onChange(toggleAnswer(r,v))}><span className="answer-dot">{r.answer===v?'●':'○'}</span>{v?'正确':'错误'}</button>)}</div>:<button type="button" disabled={r.options.length>=8} onClick={()=>set({options:[...r.options,{key:'ABCDEFGH'[r.options.length],content:''}]})}>添加选项</button>}
  <label>解析<textarea value={r.explanation} onChange={e=>set({explanation:e.target.value})}/></label>
  <div className="form-grid"><label>模型名称<input value={r.model.name} onChange={e=>set({model:{...r.model,name:e.target.value}})}/></label><label>模型版本<input value={r.model.version} onChange={e=>set({model:{...r.model,version:e.target.value}})}/></label></div>
  <label>版本来源<select value={r.model.version_source} onChange={e=>set({model:{...r.model,version_source:e.target.value as ModelReply['model']['version_source']}})}><option value="platform">平台提供</option><option value="user">用户提供</option><option value="unknown">未知</option></select></label>
  <label>需复核的内容（每行一项）<textarea value={r.warnings.join('\n')} onChange={e=>set({warnings:e.target.value.split('\n').filter(Boolean)})}/></label>
 </fieldset>;
}
