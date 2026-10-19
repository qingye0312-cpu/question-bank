import './intake/question-editor.css';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {changeQuestionType,reorderOptions,toggleAnswer,type ModelReply} from '../shared/intake';
import {bindDismissibleMenus,dismissActionMenus} from './dismissible-menus';
export function ModelEditor({value:r,onChange,disabled=false}:{value:ModelReply;onChange:(r:ModelReply)=>void;disabled?:boolean}){
 const [previousType,setPreviousType]=useState<ModelReply|null>(null);
 const editor=useRef<HTMLFieldSetElement>(null);
 useEffect(()=>editor.current?bindDismissibleMenus(editor.current):undefined,[]);
 useEffect(()=>{if(disabled&&editor.current)dismissActionMenus(editor.current)},[disabled]);
 const resize=()=>{editor.current?.querySelectorAll('textarea').forEach(el=>{
  if(!el.clientWidth)return;
  el.style.height='auto';
  const style=getComputedStyle(el);
  // scrollHeight includes padding, but not the border in border-box sizing.
  el.style.height=`${Math.ceil(el.scrollHeight+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth))}px`;
 });};
 useLayoutEffect(resize,[r]);
 useLayoutEffect(()=>{let width=0;const observer=new ResizeObserver(entries=>{const next=entries[0]?.contentRect.width||0;if(next!==width){width=next;resize()}});if(editor.current)observer.observe(editor.current);const mutation=new MutationObserver(resize);mutation.observe(document.documentElement,{attributes:true,attributeFilter:['style','class','data-font-size']});return()=>{observer.disconnect();mutation.disconnect()}},[]);
 const set=(patch:Partial<ModelReply>)=>onChange({...r,...patch});
 const move=(from:number,to:number)=>{const order=r.options.map((_,i)=>i);[order[from],order[to]]=[order[to],order[from]];onChange(reorderOptions(r,order));};
 return <fieldset ref={editor} disabled={disabled} className="model-editor">
  <label>题型<select value={r.type} onChange={e=>{setPreviousType(r);onChange(changeQuestionType(r,e.target.value as ModelReply['type']))}}>{!['single','multiple','true_false'].includes(r.type)&&<option value={r.type}>请选择题型</option>}<option value="single">单选</option><option value="multiple">多选</option><option value="true_false">判断</option></select></label>
  {previousType&&<button type="button" onClick={()=>{onChange(previousType);setPreviousType(null)}}>撤销切换题型</button>}
  <label>题干<textarea rows={1} value={r.stem} onChange={e=>set({stem:e.target.value})}/></label>
  {r.options.map((o,i)=><div key={o.key} className={`editable-option ${Array.isArray(r.answer)&&r.answer.includes(o.key)?'answer-selected':''}`}><button type="button" className="answer-dot" aria-label={`${o.key} 答案标记`} aria-pressed={Array.isArray(r.answer)&&r.answer.includes(o.key)} onClick={()=>onChange(toggleAnswer(r,o.key))}><span className="answer-indicator" aria-hidden="true"/></button><label><span className="option-key">{o.key}</span><textarea rows={1} aria-label={`选项 ${o.key}`} value={o.content} onChange={e=>set({options:r.options.map((v,n)=>i===n?{...v,content:e.target.value}:v)})}/></label>
   <details className="option-menu" data-action-menu><summary aria-label={`${o.key} 选项操作`} aria-disabled={disabled||undefined} onClick={e=>{if(disabled)e.preventDefault()}}>•••</summary><div><button type="button" disabled={i===0} onClick={()=>move(i,i-1)}>上移</button><button type="button" disabled={i===r.options.length-1} onClick={()=>move(i,i+1)}>下移</button><button type="button" disabled={r.type!=='true_false'&&r.options.length<=2} onClick={()=>onChange(reorderOptions(r,r.options.map((_,n)=>n).filter(n=>n!==i)))}>删除</button></div></details></div>)}
  {r.type==='true_false'?<div className="judgment-answers">{[true,false].map(v=><button key={String(v)} type="button" className={r.answer===v?'answer-selected':''} aria-pressed={r.answer===v} onClick={()=>onChange(toggleAnswer(r,v))}><span className="answer-indicator" aria-hidden="true"/>{v?'正确':'错误'}</button>)}</div>:<button type="button" className="add-option" disabled={r.options.length>=8} onClick={()=>set({options:[...r.options,{key:'ABCDEFGH'[r.options.length],content:''}]})}>添加选项</button>}
  <label>解析<textarea rows={1} value={r.explanation} onChange={e=>set({explanation:e.target.value})}/></label>
  <details className="intake-metadata" onToggle={resize}><summary>模型来源与内容提示</summary><div className="form-grid"><label>模型名称<input value={r.model.name} onChange={e=>set({model:{...r.model,name:e.target.value}})}/></label><label>模型版本<input value={r.model.version} onChange={e=>set({model:{...r.model,version:e.target.value}})}/></label></div>
  <label>版本来源<select value={r.model.version_source} onChange={e=>set({model:{...r.model,version_source:e.target.value as ModelReply['model']['version_source']}})}><option value="platform">平台提供</option><option value="user">用户提供</option><option value="unknown">未知</option></select></label>
  <label>需复核的内容（每行一项）<textarea rows={1} value={r.warnings.join('\n')} onChange={e=>set({warnings:e.target.value.split('\n').filter(Boolean)})}/></label>
 </details></fieldset>;
}
