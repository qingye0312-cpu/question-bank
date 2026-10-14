import React,{useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-dialog';
import {ScanText,ClipboardPaste,ImagePlus,X,CheckCircle2,RefreshCw,ArrowUpRight} from 'lucide-react';
import type {Bank} from './types';
import {OcrController,readImage} from './ocr-client';
import type {OcrEngine,OcrImage,OcrInput,Recognition,Matches} from './ocr-client';
import {OcrCrop} from './ocr-crop';

export function OcrPanel({banks,bankId,initial,onClose,onSearch}:{banks:Bank[];bankId:string;initial:OcrInput|null;onClose:()=>void;onSearch:(text:string,bankId:string)=>void}){
  const [selectedBank,setSelectedBank]=useState(bankId||banks[0]?.id||'');
  const [engine,setEngine]=useState<OcrEngine>('auto');
  const [image,setImage]=useState<OcrImage|null>(null),[text,setText]=useState('');
  const [cropImage,setCropImage]=useState<OcrImage|null>(null);
  const [recognition,setRecognition]=useState<Recognition|null>(null),[matches,setMatches]=useState<Matches|null>(null);
  const [status,setStatus]=useState(''),[error,setError]=useState(''),[running,setRunning]=useState(false),[matching,setMatching]=useState(false),[selected,setSelected]=useState<number|null>(null);
  const generation=useRef(0),matchGeneration=useRef(0),controller=useRef<OcrController|null>(null),mounted=useRef(true),picker=useRef<HTMLInputElement>(null),textarea=useRef<HTMLTextAreaElement>(null),panel=useRef<HTMLElement>(null);
  const busy=running;
  function cancel(){generation.current++;controller.current?.cancel().catch(()=>{});controller.current=null;invoke('ocr_cancel_capture').catch(()=>{});setRunning(false);setStatus('已取消，可重新截图或粘贴')}
  function invalidate(){matchGeneration.current++;setMatches(null);setSelected(null);setError('')}
  function updateText(value:string){invalidate();setText(value)}
  async function accept(input:OcrInput){
    const current=++generation.current;
    controller.current?.cancel().catch(()=>{});invalidate();setRecognition(null);setImage(input.image||null);
    if(!input.image){setRunning(false);setStatus('');setText(input.text||'');textarea.current?.focus();return}
    setText('');setRunning(true);setStatus('正在准备图片…');
    const ocr=new OcrController();controller.current=ocr;
    try{
      const result=await ocr.recognize(input.image,engine,message=>{if(mounted.current&&current===generation.current)setStatus(message)});
      if(!mounted.current||current!==generation.current)return;
      setRecognition(result);setText(result.text);setStatus('');
      if(!result.text.trim())setError('没有识别到文字，请重新截取清晰的题干和选项');
    }catch(e){if(mounted.current&&current===generation.current){setError(String(e));setStatus('')}}
    finally{if(mounted.current&&current===generation.current)setRunning(false)}
  }
  async function capture(){
    const current=++generation.current;controller.current?.cancel().catch(()=>{});invalidate();setRunning(true);setStatus('正在截取屏幕，请稍候…');
    try{const result=await invoke<OcrImage|null>('ocr_capture');if(mounted.current&&current===generation.current){if(result?.needs_crop){setRunning(false);setStatus('');setCropImage(result)}else if(result)await accept({image:result});else{setRunning(false);setStatus('已取消截图')}}}
    catch(e){if(mounted.current&&current===generation.current){setRunning(false);setStatus('');setError(String(e))}}
  }
  async function paste(){
    try{
      if(isTauri()){const value=await invoke<OcrInput>('ocr_clipboard');if(!value.image&&!value.text?.trim())throw Error('剪贴板没有图片或题目文字，请先复制');await accept(value)}
      else{textarea.current?.focus();setStatus('请按 Ctrl / ⌘ V 粘贴图片或题目文字')}
    }catch(e){setError(String(e))}
  }
  async function file(file:File){try{await accept({image:await readImage(file)})}catch(e){setError(String(e))}}
  async function choose(){
    if(!isTauri()){picker.current?.click();return}
    try{const path=await open({multiple:false,title:'选择题目截图',filters:[{name:'题目图片',extensions:['png','jpg','jpeg','webp']}]});if(path&&!Array.isArray(path))await accept({image:await invoke<OcrImage>('ocr_image_file',{path})})}catch(e){setError(String(e))}
  }
  useEffect(()=>{
    const trap=(e:KeyboardEvent)=>{if(e.key!=='Tab'||!panel.current)return;const controls=Array.from(panel.current.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary'));const first=controls[0],last=controls.at(-1);if(!first||!last)return;if(e.shiftKey&&(document.activeElement===first||!panel.current.contains(document.activeElement))){e.preventDefault();last.focus()}else if(!e.shiftKey&&(document.activeElement===last||!panel.current.contains(document.activeElement))){e.preventDefault();first.focus()}};
    document.addEventListener('keydown',trap);return()=>document.removeEventListener('keydown',trap);
  },[]);
  useEffect(()=>{
    mounted.current=true;if(initial)accept(initial);else textarea.current?.focus();
    return()=>{mounted.current=false;generation.current++;matchGeneration.current++;controller.current?.cancel().catch(()=>{});invoke('ocr_cancel_capture').catch(()=>{})};
  },[]);
  useEffect(()=>{
    const sequence=++matchGeneration.current;
    setMatches(null);setSelected(null);setMatching(false);
    if(running||!text.trim()||!selectedBank)return;
    setMatching(true);
    const timer=setTimeout(()=>{
      invoke<Matches>('ocr_match',{bankId:selectedBank,text}).then(value=>{
        if(mounted.current&&sequence===matchGeneration.current){setMatches(value);setSelected(value.automatic?value.candidates[0]?.hit.rowid??null:null);setMatching(false)}
      }).catch(e=>{if(mounted.current&&sequence===matchGeneration.current){setError(String(e));setMatching(false)}});
    },200);
    return()=>{clearTimeout(timer);matchGeneration.current++};
  },[text,selectedBank,running]);
  const candidate=matches?.candidates.find(c=>c.hit.rowid===selected);
  if(cropImage)return <div className="modal-backdrop ocr-backdrop"><section ref={panel} className="modal ocr-modal" role="dialog" aria-modal="true" aria-label="框选题目"><OcrCrop image={cropImage} onCrop={value=>{setCropImage(null);accept({image:value})}} onCancel={()=>setCropImage(null)}/></section></div>;
  return <div className="modal-backdrop ocr-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose()}}>
    <section ref={panel} className="modal ocr-modal" role="dialog" aria-modal="true" aria-labelledby="ocr-title"
      onPaste={e=>{const item=Array.from(e.clipboardData.items).find(i=>i.type.startsWith('image/'));if(item){e.preventDefault();const f=item.getAsFile();if(f)file(f)}else if(!(e.target instanceof HTMLTextAreaElement)){const value=e.clipboardData.getData('text/plain');if(value.trim()){e.preventDefault();accept({text:value})}}}}
      onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)file(f)}}>
      <button className="close-modal" aria-label="关闭识题" onClick={onClose}><X size={20}/></button>
      <div className="ocr-heading"><div className="modal-icon"><ScanText/></div><div><h2 id="ocr-title">截图 / 粘贴识题</h2><p>截取一道题，或粘贴图片与文字，自动查找题库答案。</p></div></div>
      <div className="ocr-actions"><button className="primary" disabled={busy||!isTauri()} onClick={capture}><ScanText size={17}/>截取屏幕</button><button disabled={busy} onClick={paste}><ClipboardPaste size={17}/>粘贴识别</button><button disabled={busy} onClick={choose}><ImagePlus size={17}/>选择图片</button><span>Ctrl / ⌘ V · 支持拖入图片</span><input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={e=>{const f=e.target.files?.[0];if(f)file(f);e.target.value=''}}/></div>
      <div className="ocr-controls"><label>匹配题库<select aria-label="识题匹配题库" value={selectedBank} onChange={e=>{invalidate();setSelectedBank(e.target.value)}}>{banks.map(b=><option key={b.id} value={b.id}>{b.name} · {b.count} 题</option>)}</select></label><label>识别引擎<select aria-label="识别引擎" disabled={busy} value={engine} onChange={e=>setEngine(e.target.value as OcrEngine)}><option value="auto">自动（系统优先）</option><option value="system">系统 OCR</option><option value="builtin">内置中英文 OCR</option></select></label></div>
      <div className="ocr-columns"><div className="ocr-source">
        {image&&<div className="ocr-image"><img src={image.data_url} alt="待识别的题目截图"/><div><small>{image.name} · {image.width} × {image.height}</small><button disabled={busy} onClick={()=>accept({image})}>重新识别</button></div></div>}
        <label>题目文字<textarea ref={textarea} aria-label="识题文字" disabled={busy} maxLength={16000} rows={image?6:12} value={text} placeholder={'在这里粘贴完整题目…\n\nA. 选项一\nB. 选项二\nC. 选项三\nD. 选项四'} onChange={e=>updateText(e.target.value)}/></label>
        <small className="ocr-hint">修改文字会自动重新匹配。每次识别一道题，尽量包含完整选项。</small>
        {recognition&&<div className="ocr-meta">{recognition.engine} · {(recognition.elapsed_ms/1000).toFixed(2)} 秒 · {recognition.lines.length} 行</div>}
      </div><div className="ocr-results" aria-live="polite">
        {busy?<div className="ocr-placeholder"><RefreshCw className="spin" size={28}/><b>{status}</b><button onClick={cancel}>取消识别</button></div>:<>
          {matching&&<div className="ocr-status"><RefreshCw size={15} className="spin"/>正在匹配当前题库…</div>}
          {matches&&<div className={`ocr-match-status ${matches.automatic?'matched':''}`}><CheckCircle2 size={18}/><span>{matches.message}</span></div>}
          {candidate&&<section className="ocr-answer"><small>{candidate.answer_scope==='image'?'本次题目答案（已对应选项）':'题库答案'}</small><strong>{candidate.answer}</strong>{candidate.answer_details.map(s=><p key={s}>{s}</p>)}{candidate.answer_scope==='bank'&&matches!.parsed.options.length>0&&candidate.hit.question.type!=='true_false'&&<small>选项尚未完全对应，请按内容核对，勿直接套用字母。</small>}<details><summary>查看完整题目与解析</summary><p>{candidate.hit.question.stem}</p>{candidate.hit.question.options.map(o=><p key={o.key}>{o.key}. {o.content}</p>)}{candidate.hit.question.explanation&&<p>{candidate.hit.question.explanation}</p>}</details></section>}
          {matches?.candidates.length? <div className="ocr-candidates">{matches.candidates.map((c,i)=><button key={c.hit.rowid} aria-pressed={selected===c.hit.rowid} className={selected===c.hit.rowid?'active':''} onClick={()=>setSelected(c.hit.rowid)}><span>{i+1}</span><div><b>{c.hit.question.stem}</b><small>{c.hit.question.external_id} · {c.exact_stem?'题干一致':'相近题目'}{c.options_matched?' · 选项已对应':''}</small></div></button>)}</div>:!matching&&<div className="ocr-placeholder"><ScanText size={32}/><b>{matches?'未找到匹配题目':'答案会显示在这里'}</b><p>{matches?'可修改左侧文字，或选择其他题库。':'截图、粘贴后自动开始识别与匹配。'}</p></div>}
          {matches&&<div className="ocr-meta">检索 {matches.elapsed_ms.toFixed(1)} ms · 最多显示 8 道候选题</div>}
        </>}
      </div></div>
      {error&&<div className="ocr-error" role="alert">{error}</div>}
      {!busy&&status&&<div className="ocr-meta" role="status">{status}</div>}
      <footer className="ocr-footer"><span>答案来自所选题库 · 图片仅用于本次识别</span><button disabled={!text.trim()||busy} onClick={()=>onSearch(matches?.parsed.stem||text,selectedBank)}>转到搜索<ArrowUpRight size={15}/></button></footer>
    </section>
  </div>;
}
