import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import {IntakePanel} from './intake-panel';
import {PromptTemplate} from './prompt-template';
import {APP_VERSION} from './generated/client-assets';
import {copyText} from './clipboard';
import {open, save} from '@tauri-apps/plugin-dialog';
import {Search,Library,Package,Upload,Plus,ArrowUpRight,ChevronRight,FileDown,Settings,Check,Copy,Edit3,Trash2,X,FolderOpen,Lock,RefreshCw,BookOpen,History,CheckCircle2,Download,HardDrive,Layers,Keyboard,ScanText,PanelLeftClose,PanelLeftOpen,ChevronsUp,Eye} from 'lucide-react';
import './styles.css';
import {benchmarkCases,percentiles} from './benchmark';
import type {Question, Bank, Hit, Results} from './types';
import {SpeedResults, SearchMark as Mark, answerText as formatAnswer} from './speed-results';
import {DetailResults} from './detail-results';
import {animateSearchLayout} from './layout-motion';
import {defaults, fontSizes, themes, loadPreferences, preferenceKey} from './preferences';
import type {Mode} from './preferences';
import {OcrPanel} from './ocr-panel';
import {looksLikeQuestion,readImage} from './ocr-client';
import type {OcrInput} from './ocr-client';

type Preview={token:string;filename:string;name:string;count:number;review_count:number;errors:string[];warnings:string[];samples:Question[];package:boolean;action:string;added:number;changed:number;removed:number};
const kinds:Record<string,string>={single:'单选',multiple:'多选',true_false:'判断'};
const blank=():Question=>({schema_version:'1.0',question_id:'',base_revision:1,type:'single',stem:'',options:['A','B','C','D'].map(key=>({key,content:''})),answer:[],external_id:'',bank:'',chapter:'',explanation:'',tags:[],difficulty:'',applicable_version:'',source_note:'',status:'unreviewed',issues:[],sources:[],attachments:[]});


function App(){
 const [preferences,setPreferences]=useState(loadPreferences);
 const [mode,setMode]=useState<Mode>(preferences.mode);
 const fontScale=fontSizes.find(f=>f.id===preferences.fontSize)!.scale;
 const [banks,setBanks]=useState<Bank[]>([]),[bankId,setBankId]=useState(preferences.bankId),[text,setText]=useState(''),[committed,setCommitted]=useState(''),[kind,setKind]=useState(''),[trash,setTrash]=useState(false),[results,setResults]=useState<Results>({items:[],has_more:false,elapsed_ms:0}),[active,setActive]=useState<Hit|null>(null),[answerOpen,setAnswerOpen]=useState(true),[revision,setRevision]=useState(0);
 const [busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState(''),[modal,setModal]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[draft,setDraft]=useState<Question|null>(null),[editBank,setEditBank]=useState(''),[name,setName]=useState(''),[exportBank,setExportBank]=useState(''),[exportFormat,setExportFormat]=useState('package'),[importTarget,setImportTarget]=useState(''),[history,setHistory]=useState<{question:Question;at:string;reason:string}[]>([]),[info,setInfo]=useState<Record<string,string>>({});
 const [intakeInitial,setIntakeInitial]=useState(''),[dropping,setDropping]=useState(false);
 const dropHandler=useRef<(paths:string[])=>void>(()=>{});
 function openIntake(value=''){setIntakeInitial(value);setModal('intake')}
 const [ocrInitial,setOcrInitial]=useState<OcrInput|null>(null);
 function openOcr(initial:OcrInput|null=null){setOcrInitial(initial);setModal('ocr')}
 const input=useRef<HTMLInputElement>(null),composing=useRef(false);
 const searchArea=useRef<HTMLDivElement>(null);
 const benchPending=useRef<null|((r:Results)=>void)>(null);
 const bank=banks.find(b=>b.id===bankId),detailBank=banks.find(b=>b.id===active?.bank_id),total=banks.reduce((n,b)=>n+b.count,0);
 async function refresh(){const all=await invoke<Bank[]>('banks');setBanks(all);setRevision(r=>r+1);return all;}
 async function work<T,>(label:string,fn:()=>Promise<T>):Promise<T|undefined>{setBusy(label);setError('');try{return await fn()}catch(e){setError(String(e));return undefined}finally{setBusy('')}}
 useEffect(()=>{
  document.documentElement.dataset.theme=preferences.theme;
  document.documentElement.style.setProperty('--font-scale',String(fontScale));
  document.documentElement.dataset.fontSize=preferences.fontSize;
  try{localStorage.setItem(preferenceKey,JSON.stringify({...preferences,mode,bankId}));}catch{/* A full disk must not stop offline search. */}
 },[preferences,mode,bankId,fontScale]);
 useEffect(()=>{if(banks.length&&((bankId&&!banks.some(b=>b.id===bankId))||(mode==='speed'&&!bankId)))setBankId(banks[0].id)},[banks,bankId,mode]);
 useEffect(()=>{work('正在打开本地题库',async()=>{await refresh();setInfo(await invoke('app_info'));});},[]);
 useEffect(()=>{const handle=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='o'&&!modal){e.preventDefault();openOcr();return}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&!modal){e.preventDefault();input.current?.focus();input.current?.select();}if(e.key==='Escape'){if(modal&&!busy){setModal('');setDraft(null)}else{input.current?.focus();}}};window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);},[results,active,modal,busy]);
 useEffect(()=>{const paste=(e:ClipboardEvent)=>{if(modal||busy||!e.clipboardData)return;const item=Array.from(e.clipboardData.items).find(i=>i.type.startsWith('image/'));if(item){const file=item.getAsFile();if(file){e.preventDefault();readImage(file).then(image=>openOcr({image})).catch(e=>setError(String(e)))}return}const value=e.clipboardData.getData('text/plain');if(value.includes('qbank-photo-question-1')){e.preventDefault();openIntake(value);return}if(looksLikeQuestion(value)){e.preventDefault();openOcr({text:value})}};window.addEventListener('paste',paste);return()=>window.removeEventListener('paste',paste)},[modal,busy]);
 useEffect(()=>{if(benchPending.current){requestAnimationFrame(()=>requestAnimationFrame(()=>{const done=benchPending.current;benchPending.current=null;done?.(results)}));}},[results]);
 useEffect(()=>{if(notice){const t=setTimeout(()=>setNotice(''),8000);return()=>clearTimeout(t)}},[notice]);
 function switchMode(next:Mode){
  if(next==='speed'&&!bankId)setBankId(active?.bank_id||banks[0]?.id||'');
  setMode(next);setError('');setNotice('');
  requestAnimationFrame(()=>input.current?.focus());
 }
 function switchBank(id:string){setBankId(id);setTrash(false)}
 function openExport(format='package'){setExportBank(bankId||active?.bank_id||banks[0]?.id||'');setExportFormat(format);setModal('export')}
 async function doExport(){await work('正在制作文件，请稍候',async()=>{const b=banks.find(b=>b.id===exportBank);if(!b)throw Error('请选择题库');const ext=exportFormat==='package'?'qbank.zip':exportFormat;const path=await save({title:exportFormat==='package'?'制作离线题库包':'导出题库',defaultPath:`${b.name.replace(/[\\/:*?"<>|]/g,'_')}_v${b.version}.${ext}`,filters:[{name:ext,extensions:exportFormat==='package'?['zip']:[ext]}]});if(!path)return;const count=await invoke<number>('export_bank',{bankId:exportBank,path,format:exportFormat});setModal('');setNotice(`已保存 ${count.toLocaleString()} 题：${path}`);})}
 async function importDelta(path:string){
  const result=await invoke<{bank_id:string;name:string;added:number;skipped:number;conflicts:number}>('import_delta',{path});
  await refresh();switchBank(result.bank_id);setModal('');
  setNotice(`「${result.name}」新增 ${result.added} 题，跳过 ${result.skipped} 道重复题${result.conflicts?`；${result.conflicts} 道答案或 ID 不一致，已保留现有题目`:''}。`);
 }
 dropHandler.current=(paths)=>{
  setDropping(false);if(!paths.some(p=>p.toLowerCase().endsWith('.json')))return;if(busy||(modal&&!['import','settings','templates'].includes(modal))){setError('请先完成当前录入，再拖入增量包。');return}
  if(paths.length!==1||!paths[0].toLowerCase().endsWith('.json')){setError('请一次拖入一个 .qbank-delta.json 增量题库文件。');return}
  void work('正在合并增量题库',()=>importDelta(paths[0]));
 };
 useEffect(()=>{
  if(!isTauri())return;let disposed=false;let unlisten:(()=>void)|undefined;
  getCurrentWebview().onDragDropEvent(event=>{
   if(event.payload.type==='drop')dropHandler.current(event.payload.paths);
   else if(event.payload.type==='enter')setDropping(event.payload.paths.some(p=>p.toLowerCase().endsWith('.json')));
   else if(event.payload.type==='leave')setDropping(false);
  }).then(fn=>{if(disposed)fn();else unlisten=fn}).catch(()=>setError('拖入入口未能启用，请用「导入」选择增量包。'));
  return()=>{disposed=true;unlisten?.()};
 },[]);
 async function chooseImport(){await work('正在解析与校验文件',async()=>{const path=await open({multiple:false,filters:[{name:'题库文件',extensions:['xlsx','docx','jsonl','zip','json']}]});if(!path||Array.isArray(path))return;
  if(path.toLowerCase().endsWith('.json')){await importDelta(path);return}
  const p=await invoke<Preview>('import_preview',{path,bankId:importTarget});setPreview(p);setModal('preview');})}

 async function applyImport(){if(!preview)return;await work('正在导入并建立索引',async()=>{const id=await invoke<string>('import_commit',{token:preview.token});await refresh();switchBank(id);setModal('');setPreview(null);setNotice('导入完成，可以离线搜索，也可以再次制作题库包。')})}
 async function template(format:string){await work('正在准备模板',async()=>{const path=await save({defaultPath:`题库导入模板_v1.${format}`,filters:[{name:format,extensions:[format]}]});if(path){await invoke('download_template',{path,format});setNotice(`模板已保存：${path}`);}})}
 async function fork(id:string){await work('正在建立可编辑副本',async()=>{const newId=await invoke<string>('fork_bank',{bankId:id});await refresh();switchBank(newId);setModal('');setNotice('副本已建立；来源信息已保留。')})}
 function edit(hit?:Hit){const target=hit?.bank_id||(bank&&!bank.read_only?bank.id:'')||banks.find(b=>!b.read_only)?.id||'';if(!target){setModal('create');return}setEditBank(target);setDraft(hit?structuredClone(hit.question):blank());setModal('edit')}
 async function saveDraft(){if(!draft)return;await work('正在保存题目',async()=>{await invoke('save_question',{bankId:editBank,question:draft});await refresh();switchBank(editBank);setModal('');setDraft(null);setNotice('题目已保存，搜索索引已同步更新。')})}
 async function deleteActive(restore=false){if(!active)return;await work(restore?'正在恢复题目':'正在移入回收站',async()=>{await invoke('delete_question',{rowid:active.rowid,restore});await refresh();setModal('');setNotice(restore?'题目已恢复。':'题目已移入回收站，可以恢复。')})}
 async function copy(){if(!active)return;const q=active.question;try{await copyText(`${q.stem}\n${q.options.map(o=>o.key+'. '+o.content).join('\n')}\n答案：${formatAnswer(q)}${q.explanation?'\n解析：'+q.explanation:''}`);setNotice('题目与答案已复制。')}catch{setError('无法访问剪贴板，请选中文字复制。')}}
 async function runBenchmark(){await work('正在验证界面响应',async()=>{
  const b=banks.find(b=>b.name.startsWith('性能验证 ·'));if(!b)throw Error('请使用 qbank-tool 生成的独立性能验证库');
  const cases=benchmarkCases(b.count,b.id),samples:{round:number;case:number;text:string;ui_ms:number;core_ms:number;rows:number}[]=[];
  setModal('');setTrash(false);setAnswerOpen(true);
  for(let round=0;round<3;round++)for(let j=0;j<cases.length;j++){
   if(document.visibilityState!=='visible')throw Error('请保持测试窗口在前台后重新运行');
   const index=(j*73+round*19)%cases.length,c=cases[index];
   const started=performance.now();
   const result=await new Promise<Results>((resolve,reject)=>{
    const timer=setTimeout(()=>{benchPending.current=null;reject(Error('界面测试超时'))},5000);
    benchPending.current=r=>{clearTimeout(timer);resolve(r)};
    setText(c.text);setCommitted(c.text);setBankId(mode==='speed'?b.id:c.bank);setKind(c.kind);setRevision(r=>r+1);
   });
   samples.push({round,case:index,text:c.text,ui_ms:performance.now()-started,core_ms:result.elapsed_ms,rows:result.items.length});
   setBusy(`界面验证 ${samples.length} / 600`);
  }
  const report={at:new Date().toISOString(),questions:b.count,query_cases:200,query_suite:mode==='speed'?'v2-mixed-speed-all-types-selected-bank':'v2-mixed',mode,font_size:preferences.fontSize,theme:preferences.theme,rounds:3,ui_ms:percentiles(samples.map(s=>s.ui_ms)),core_ms:percentiles(samples.map(s=>s.core_ms)),measures:'React search state to two animation frames after results commit; includes IPC, SQLite and UI; excludes physical keyboard dispatch; OS cache uncontrolled',info,samples};
  const path=await invoke<string>('save_benchmark',{report});setNotice(`界面验证完成：P95 ${report.ui_ms.p95.toFixed(1)} ms；${path}`);
 })}
 const q=active?.question;
 const modeSwitch=<div className="mode-switch" role="group" aria-label="页面模式">{([['detail','详细模式'],['speed','极速模式']] as const).map(([value,label])=><button key={value} aria-pressed={mode===value} className={mode===value?'active':''} onClick={()=>switchMode(value)}>{label}</button>)}</div>;
 const searchBox=<div className="search-box"><Search size={22}/><input ref={input} autoFocus aria-label={mode==='speed'?`搜索当前题库：${bank?.name||'正在载入'}`:'搜索题目'} placeholder={mode==='speed'?`搜索「${bank?.name||'当前题库'}」中的全部题目…`:'搜索题目、选项、标签、章节或编号…'} value={text} onChange={e=>{setText(e.target.value);if(!composing.current){setCommitted(e.target.value)}}} onCompositionStart={()=>{composing.current=true}} onCompositionEnd={e=>{composing.current=false;setCommitted(e.currentTarget.value)}}/>{text?<button aria-label="清空搜索" onClick={()=>{setText('');setCommitted('');input.current?.focus()}}><X size={17}/></button>:mode==='detail'?<kbd>⌘ / Ctrl K</kbd>:null}<button className="ocr-search-entry" title="截图 / 粘贴识题（⌘ / Ctrl Shift O）" aria-label="截图或粘贴识题" onClick={()=>openOcr()}><ScanText size={19}/></button></div>;
 return <div className={`app ${mode==='speed'?'speed-mode':''}`}>
  {mode==='detail'&&<div id="workspace-sidebar" className={`sidebar-shell ${preferences.sidebarCollapsed?'is-collapsed':''}`} aria-hidden={preferences.sidebarCollapsed} inert={preferences.sidebarCollapsed}><aside className="sidebar">
   <div className="brand"><div className="brand-mark"><Layers size={24}/></div><div><b>题库</b><small>离线知识工作台</small></div><span className="version">01</span></div>
   <div className="workspace-label">我的工作空间 <span>LOCAL</span></div>
   <button className={`nav-item ${!bankId&&!trash?'selected':''}`} onClick={()=>switchBank('')}><Library size={18}/>全部题目 <span>{total.toLocaleString()}</span></button>
   <div className="section-label">题库 <button title="新建题库" aria-label="新建题库" onClick={()=>{setName('');setModal('create')}}><Plus size={15}/></button></div>
   <div className="bank-nav">{banks.map(b=><button className={`bank-item ${bankId===b.id&&!trash?'selected':''}`} key={b.id} onClick={()=>switchBank(b.id)}><span className={`bank-dot ${b.read_only?'readonly':''}`}/><div><b>{b.name}</b><small>{b.read_only?'发布题库':'可编辑'} · {b.count.toLocaleString()} 题</small></div>{b.read_only&&<Lock size={12}/>}</button>)}</div>
   <div className="nav-divider"/>
   <button className={`nav-item ${trash?'selected':''}`} onClick={()=>{setTrash(true)}}><Trash2 size={17}/>回收站</button>
   <button className="nav-item" onClick={()=>setModal('templates')}><FileDown size={17}/>录题模板 <ArrowUpRight className="muted" size={14}/></button>
   <button className="nav-item" onClick={()=>openIntake()}><Plus size={17}/>大模型录题</button>
   <div className="share-card"><Package size={23}/><b>把题库带到任何电脑</b><p>制作离线包，分享给同事。<br/>每台客户端都可以制包。</p><button onClick={()=>openExport()}>制作题库包 <ArrowUpRight size={15}/></button></div>
   <button className="nav-item settings" onClick={()=>setModal('settings')}><Settings size={17}/>设置与维护 <span>v{APP_VERSION}</span></button>
   <div className="local-status"><i/> 数据保存在本机</div>
  </aside></div>}
  <main>
   {mode==='speed'?<>
    <header className="speed-header"><div className="speed-tools"><button className="speed-settings" title="设置与维护" aria-label="设置与维护" onClick={()=>setModal('settings')}><Settings size={19}/></button><button className="speed-preview-toggle" title={preferences.speedPreview?'关闭题目预览':'开启题目预览：鼠标移入题目立即显示'} aria-label="题目预览" aria-pressed={preferences.speedPreview} onClick={()=>setPreferences(p=>({...p,speedPreview:!p.speedPreview}))}><Eye size={18}/><span>预览</span></button></div>{searchBox}{modeSwitch}</header>
    <SpeedResults bankId={bankId||'__no_selected_bank__'} query={committed} revision={revision} fontScale={fontScale} previewEnabled={preferences.speedPreview&&!modal&&!busy} onResults={setResults}/>
   </>:<>

   <header className="topbar"><button className="sidebar-toggle" aria-label={preferences.sidebarCollapsed?'展开侧栏':'收起侧栏'} title={preferences.sidebarCollapsed?'展开侧栏':'收起侧栏'} aria-expanded={!preferences.sidebarCollapsed} aria-controls="workspace-sidebar" onClick={()=>setPreferences(p=>({...p,sidebarCollapsed:!p.sidebarCollapsed}))}>{preferences.sidebarCollapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}</button><div className="breadcrumb">工作空间 <ChevronRight size={13}/> <b>{trash?'回收站':bank?.name||'全部题目'}</b></div>{modeSwitch}<div className="top-actions"><button onClick={()=>openOcr()}><ScanText size={16}/>截图识题</button><button onClick={()=>{setImportTarget(bank&&!bank.read_only?bank.id:'');setModal('import')}}><Upload size={16}/>导入</button><button className="primary" onClick={()=>openExport()}><Package size={16}/>制作离线包</button></div></header>
   <div className="search-area-shell" ref={searchArea}><section id="detail-search-area" className={`search-area ${preferences.searchCollapsed?'is-collapsed':''}`}><div className="title-line"><div><div className="eyebrow">YOUR QUESTION LIBRARY</div><h1>{trash?'回收站':bank?.name||'找到问题，也找到答案。'}</h1><p>{trash?'已删除的题目可随时恢复。':bank?`${bank.count.toLocaleString()} 道题目 · 版本 v${bank.version} · ${new Date(bank.updated_at).toLocaleDateString()} · ${bank.read_only?'已导入的发布快照':'在本机维护与发布'}`:'输入题干片段、中文关键词或 API 名，直接搜索本机题库。'}</p></div><div className="library-stat"><strong>{(bank?.count??total).toLocaleString()}</strong><small>本地题目</small></div></div>
   {searchBox}
   <div className="filter-row">{preferences.searchCollapsed?<select className="compact-kind" aria-label="筛选题型" value={kind} onChange={e=>{setKind(e.target.value)}}>{[['','全部题型'],...Object.entries(kinds)].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>:<div className="segmented">{[['','全部题型'],...Object.entries(kinds)].map(([value,label])=><button key={value} className={kind===value?'active':''} onClick={()=>{setKind(value)}}>{label}</button>)}</div>}<span className="search-meta">{results.elapsed_ms.toFixed(1)} ms 查询 · 连续滚动</span><button className="text-button add-question" title="新增题目" aria-label="新增题目" onClick={()=>edit()}><Plus size={15}/><span className="add-question-label">新增题目</span></button><button className="search-collapse-toggle" aria-label={preferences.searchCollapsed?'展开搜索区':'收起搜索区'} title={preferences.searchCollapsed?'展开搜索区':'收起搜索区'} aria-expanded={!preferences.searchCollapsed} aria-controls="detail-search-area" onClick={()=>animateSearchLayout(searchArea.current,()=>setPreferences(p=>({...p,searchCollapsed:!p.searchCollapsed})))}><ChevronsUp size={15}/><span>{preferences.searchCollapsed?'展开':'收起搜索区'}</span></button></div></section></div>
   <div className="content-grid"><DetailResults bankId={bankId} query={committed} kind={kind} trash={trash} revision={revision} fontScale={fontScale} active={active} keyboardEnabled={!modal} onSelect={hit=>{setActive(hit);setAnswerOpen(true)}} onResults={(result,initial)=>{setResults(result);if(initial)setActive(old=>result.items.find(hit=>hit.rowid===old?.rowid)||result.items[0]||null)}}/>
   <section className="detail-pane">{q&&active?<><div className="detail-toolbar"><span>题目详情</span><div><button title="复制题目与答案" aria-label="复制题目与答案" onClick={copy}><Copy size={16}/></button><button title="修订历史" aria-label="修订历史" onClick={()=>work('正在读取历史',async()=>{setHistory(await invoke('history',{bankId:active.bank_id,questionId:q.question_id}));setModal('history')})}><History size={16}/></button>{!detailBank?.read_only&&!trash&&<><button aria-label="编辑题目" title="编辑题目" onClick={()=>edit(active)}><Edit3 size={16}/></button><button aria-label="删除题目" title="移入回收站" onClick={()=>setModal('delete')}><Trash2 size={16}/></button></>}</div></div><div className="detail-scroll"><div className="detail-meta"><span className={`type-badge ${q.type}`}>{kinds[q.type]}</span><span>{q.external_id||'自建题目'}</span><span className="detail-revision">修订 {q.base_revision}</span></div><h2><Mark text={q.stem} query={committed}/></h2><div className="choices">{q.options.map(o=><div key={o.key} className={`choice ${answerOpen&&Array.isArray(q.answer)&&q.answer.includes(o.key)?'correct':''}`}><span className="choice-key">{o.key}</span><p><Mark text={o.content} query={committed}/></p>{answerOpen&&Array.isArray(q.answer)&&q.answer.includes(o.key)&&<Check size={16}/>}</div>)}</div><div className="answer-card"><div className="answer-heading"><span><CheckCircle2 size={16}/>参考答案</span><button onClick={()=>setAnswerOpen(!answerOpen)}>{answerOpen?'收起':'显示答案'}</button></div>{answerOpen&&<><strong>{formatAnswer(q)}</strong>{q.explanation&&<p className="explanation">{q.explanation}</p>}</>}</div>{trash&&<button className="primary wide" onClick={()=>deleteActive(true)}><RefreshCw size={16}/>恢复这道题</button>}{detailBank?.read_only&&<div className="readonly-note"><Lock size={14}/><span>发布版本 v{detailBank.version}，可直接再次制包。</span><button onClick={()=>fork(detailBank.id)}>建立可编辑副本</button></div>}<div className="question-footer"><div><span>题库</span><b>{active.bank_name}</b></div>{q.chapter&&<div><span>章节</span><b>{q.chapter}</b></div>}{q.tags.length>0&&<div><span>标签</span><b>{q.tags.join(' / ')}</b></div>}{q.applicable_version&&<div><span>适用版本</span><b>{q.applicable_version}</b></div>}</div><details className="source-details"><summary>来源记录与原文</summary>{q.sources.length===0?<p>{q.source_note||'本机录入'}</p>:q.sources.map((s,i)=><pre key={i}>{typeof s.raw_text==='string'?`${s.file||''}\n\n${s.raw_text}`:JSON.stringify(s,null,2)}</pre>)}</details></div></>:<div className="empty detail-empty"><BookOpen size={44}/><b>从左侧选择一道题</b><p>答案、选项与解析会显示在这里。</p></div>}</section></div>
   <footer className="statusbar"><span><HardDrive size={13}/> 本地索引已就绪</span><span><Keyboard size={13}/> Alt ↑ ↓ 切换题目 · ⌘ / Ctrl K 搜索</span></footer>
   </>}
  </main>
  {(notice||error)&&<div className={`toast ${error?'error':''}`} role={error?'alert':'status'}><span>{error||notice}</span><button aria-label="关闭提示" onClick={()=>{setError('');setNotice('')}}><X size={16}/></button></div>}
  {busy&&<div className="busy" role="status"><RefreshCw size={16} className="spin"/>{busy}</div>}
  {dropping&&<div className="delta-drop-overlay">松开即可导入对应题库<br/><small>增量合并 · 自动跳过重复题</small></div>}
  {modal==='intake'&&<IntakePanel banks={banks} bankId={bankId||active?.bank_id||''} initial={intakeInitial} onClose={()=>setModal('')} onBusy={value=>setBusy(value?'正在处理录入':'')} onSaved={async id=>{await refresh();switchBank(id)}}/>}
  {modal==='ocr'&&<OcrPanel banks={banks} bankId={bankId||active?.bank_id||''} initial={ocrInitial} onClose={()=>setModal('')} onSearch={(value,id)=>{setModal('');switchBank(id);setText(value);setCommitted(value);input.current?.focus()}}/>}
  {modal&&modal!=='ocr'&&modal!=='intake'&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy){setModal('');setDraft(null)}}}><section className={`modal ${modal==='edit'?'large':''}`} role="dialog" aria-modal="true"><button className="close-modal" aria-label="关闭" disabled={!!busy} onClick={()=>{setModal('');setDraft(null)}}><X size={20}/></button>
   {modal==='create'&&<><div className="modal-icon"><Library/></div><h2>建立自己的题库</h2><p>题目保存在这台电脑，随时可以制作离线包。</p><label>题库名称<input value={name} onChange={e=>setName(e.target.value)} placeholder="例如：开发基础 · 2026" autoFocus/></label><button className="primary wide" disabled={!name.trim()||!!busy} onClick={()=>work('正在创建题库',async()=>{const id=await invoke<string>('create_bank',{name});await refresh();switchBank(id);setModal('')})}>创建题库</button></>}
   {modal==='export'&&<><div className="modal-icon"><Package/></div><h2>{exportFormat==='package'?'制作离线题库包':'导出题库'}</h2><p>每台客户端均可制包。离线包包含整库题目、答案、来源和版本，接收者导入后即可使用。</p><label>选择题库<select value={exportBank} onChange={e=>setExportBank(e.target.value)}>{banks.map(b=><option key={b.id} value={b.id}>{b.name} · {b.count} 题 · v{b.version}</option>)}</select></label><label>文件格式<select value={exportFormat} onChange={e=>setExportFormat(e.target.value)}><option value="package">离线题库包（.qbank.zip）</option><option value="xlsx">标准 Excel（.xlsx）</option><option value="docx">标准 Word（.docx）</option><option value="jsonl">标准 JSONL（.jsonl）</option></select></label><div className="callout">离线包保留题库身份与版本。导入发布包后可以继续制包；需要修改内容时，先建立可编辑副本。</div><button className="primary wide" disabled={!exportBank||!!busy} onClick={doExport}><Download size={17}/>选择位置并保存</button></>}
   {modal==='import'&&<><div className="modal-icon"><Upload/></div><h2>导入题库</h2><p>支持离线包、增量包、标准 Excel、Word 和 JSONL。增量包会按题库 ID 自动合并，也可直接拖入窗口。</p><button className="template-card" onClick={()=>openIntake()}><Plus/><div><b>粘贴大模型回复录题</b><span>先比对旧题，新题保存为独立录入批次。</span></div></button><label>标准文件的导入位置<select value={importTarget} onChange={e=>setImportTarget(e.target.value)}><option value="">新建可编辑题库</option>{banks.filter(b=>!b.read_only).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label><div className="callout">离线题库包按自身身份新建或更新发布题库，不受上方选项影响。现有旧版 Word 已完成一次迁移，后续请使用标准模板。</div><button className="primary wide" onClick={chooseImport} disabled={!!busy}><FolderOpen size={17}/>选择文件</button><button className="text-button wide" onClick={()=>setModal('templates')}>下载标准录题模板</button></>}
   {modal==='preview'&&preview&&<><div className="modal-icon"><CheckCircle2/></div><h2>导入预览</h2><p>{preview.filename}</p><div className="preview-stats"><div><b>{preview.count}</b><span>文件题目</span></div><div><b>{preview.added}</b><span>新增</span></div><div><b>{preview.changed}</b><span>变更</span></div><div><b>{preview.removed}</b><span>移除</span></div></div><div className="callout"><b>{preview.name}</b><br/>{preview.action}</div>{preview.errors.length>0?<div className="validation-errors">{preview.errors.map((s,i)=><p key={i}>{s}</p>)}</div>:<div className="sample-list">{preview.samples.map((q,i)=><p key={i}><span>{kinds[q.type]}</span>{q.stem.slice(0,100)}</p>)}</div>}<small>文件校验检查结构与完整性，不代替答案知识审核。</small><button className="primary wide" disabled={!!busy||preview.errors.length>0} onClick={applyImport}>{preview.errors.length?'请修正文件后重新导入':'确认导入'}</button></>}
   {modal==='templates'&&<><div className="modal-icon"><FileDown/></div><h2>更规范的录题方式</h2><PromptTemplate/><button className="text-button wide" onClick={()=>openIntake()}>粘贴模型回复并录入新题</button><p>三种格式共用 v1 字段规范。新题无需填写系统 ID；更新已有题目，请保留导出的系统 ID 和基准修订号。</p>{[['xlsx','Excel 模板','推荐人工批量录题，一题一行。'],['docx','Word 模板','一题一个两列表格，字段明确。'],['jsonl','JSONL 示例','程序批量交换，一行一个题目。']].map(([f,t,d])=><button className="template-card" key={f} disabled={!!busy} onClick={()=>template(f)}><FileDown/><div><b>{t}</b><span>{d}</span></div><Download size={18}/></button>)}<div className="callout">多选答案写 A|C，判断答案写“正确”或“错误”。图片、原生公式和宏暂不支持；遇到这些内容会拒绝导入并说明原因。</div></>}
   {modal==='edit'&&draft&&<><h2>{draft.question_id?'编辑题目':'新增题目'}</h2><p>填写完整选项和明确答案，保存后立即可搜索。</p><div className="form-grid"><label>题库<select value={editBank} disabled={!!draft.question_id} onChange={e=>setEditBank(e.target.value)}>{banks.filter(b=>!b.read_only).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label><label>题型<select value={draft.type} onChange={e=>setDraft({...draft,type:e.target.value,answer:e.target.value==='true_false'?true:[],options:e.target.value==='true_false'?[]:draft.options.length?draft.options:blank().options})}>{Object.entries(kinds).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label><label>外部编号<input value={draft.external_id} onChange={e=>setDraft({...draft,external_id:e.target.value})} placeholder="可选"/></label><label>章节<input value={draft.chapter} onChange={e=>setDraft({...draft,chapter:e.target.value})} placeholder="开发基础/组件"/></label></div><label>题干<textarea rows={4} value={draft.stem} onChange={e=>setDraft({...draft,stem:e.target.value})}/></label>{draft.type!=='true_false'?<><div className="options-editor">{draft.options.map((o,i)=><div key={o.key}><span>{o.key}</span><textarea rows={2} value={o.content} onChange={e=>setDraft({...draft,options:draft.options.map((v,j)=>i===j?{...v,content:e.target.value}:v)})}/><input type={draft.type==='single'?'radio':'checkbox'} name="correct" aria-label={`${o.key} 为正确答案`} checked={Array.isArray(draft.answer)&&draft.answer.includes(o.key)} onChange={e=>setDraft({...draft,answer:draft.type==='single'?[o.key]:e.target.checked?[...(Array.isArray(draft.answer)?draft.answer:[]),o.key].sort():(Array.isArray(draft.answer)?draft.answer:[]).filter(k=>k!==o.key)})}/></div>)}</div><div className="option-tools"><button disabled={draft.options.length>=8} onClick={()=>setDraft({...draft,options:[...draft.options,{key:'ABCDEFGH'[draft.options.length],content:''}]})}><Plus size={14}/>添加选项</button><button disabled={draft.options.length<=2} onClick={()=>{const last=draft.options.at(-1)?.key;setDraft({...draft,options:draft.options.slice(0,-1),answer:(Array.isArray(draft.answer)?draft.answer:[]).filter(a=>a!==last)})}}>移除末项</button><span>右侧勾选正确答案</span></div></>:<label>答案<select value={draft.answer===null?"":String(draft.answer)} onChange={e=>setDraft({...draft,answer:e.target.value==='true'})}><option value="" disabled>请选择答案</option><option value="true">正确</option><option value="false">错误</option></select></label>}<label>解析<textarea rows={3} value={draft.explanation} onChange={e=>setDraft({...draft,explanation:e.target.value})}/></label><div className="form-grid"><label>标签（用 | 分隔）<input value={draft.tags.join('|')} onChange={e=>setDraft({...draft,tags:e.target.value.split('|')})}/></label><label>答案审核<select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value,issues:e.target.value==='verified'?[]:draft.issues})}><option value="unreviewed">按来源录入</option><option value="verified">已核对正确</option><option value="needs_review">留待核对</option></select></label></div><button className="primary wide" disabled={!!busy||!banks.some(b=>b.id===editBank&&!b.read_only)} onClick={saveDraft}>保存题目</button></>}
   {modal==='delete'&&<><h2>移入回收站？</h2><p>这道题将从搜索结果中移除，可在回收站恢复。</p><button className="danger wide" disabled={!!busy} onClick={()=>deleteActive()}>移入回收站</button></>}
   {modal==='history'&&<><h2>修订历史</h2><p>恢复历史内容会新增修订，不会抹去后续记录。</p>{history.length?history.map((h,i)=><div className="history-item" key={i}><b>{h.reason} · 修订 {h.question.base_revision}</b><small>{new Date(h.at).toLocaleString()}</small><p>{h.question.stem.slice(0,160)}</p>{!detailBank?.read_only&&<button onClick={()=>{setDraft({...h.question,base_revision:q!.base_revision});setEditBank(active!.bank_id);setModal('edit')}}>载入编辑器</button>}</div>):<div className="callout">这道题还没有历史修订。</div>}</>}
   {modal==='settings'&&<><div className="modal-icon"><Settings/></div><h2>设置与维护</h2><p>题库 v{info.version||APP_VERSION} · {info.platform} / {info.arch}</p>
    <PromptTemplate/><button className="template-card" onClick={()=>openIntake()}><Plus/><div><b>大模型录题与增量包</b><span>粘贴回复、比对旧题、保存本次新题与上传标记。</span></div></button>
    <section className="appearance-settings" aria-label="显示设置">
     <h3>字体大小</h3><div className="font-options" role="group" aria-label="字体大小">{fontSizes.map(f=><button key={f.id} aria-pressed={preferences.fontSize===f.id} className={preferences.fontSize===f.id?'active':''} onClick={()=>setPreferences(p=>({...p,fontSize:f.id}))}>{f.label}{f.id==='medium'&&<small>默认</small>}</button>)}</div>
     <h3>页面配色</h3><div className="theme-options" role="group" aria-label="页面配色">{themes.map(t=><button key={t.id} aria-pressed={preferences.theme===t.id} className={preferences.theme===t.id?'active':''} onClick={()=>setPreferences(p=>({...p,theme:t.id}))}><i style={{backgroundColor:t.color}}/>{t.label}{preferences.theme===t.id&&<Check size={13}/>}</button>)}</div>
     <div className="appearance-preview"><span>字号与配色实时预览</span><b>找到问题，也找到答案。</b><small>中号沿用原大小；设置自动保存在本机。</small></div>
     <button className="text-button" onClick={()=>setPreferences(p=>({...p,fontSize:defaults.fontSize,theme:defaults.theme}))}>恢复默认显示</button>
    </section><label>本地数据库<code className="db-path">{info.database}</code></label><button className="template-card" onClick={()=>{setModal('');openExport('jsonl')}}><Download/><div><b>导出完整题库</b><span>推荐离线包保留版本，JSONL 用于数据交换。</span></div></button><button className="template-card" disabled={!!busy} onClick={()=>work('正在重建搜索索引',async()=>{await invoke('rebuild_index');setNotice('搜索索引已重建。');setRevision(r=>r+1)})}><RefreshCw/><div><b>重建搜索索引</b><span>题目内容保持不变。</span></div></button>{bank&&<><button className="template-card" onClick={()=>fork(bank.id)}><Copy/><div><b>建立当前题库的可编辑副本</b><span>{bank.name}</span></div></button><button className="template-card" onClick={()=>setModal('rollback')}><History/><div><b>回退上次导入</b><span>恢复导入前快照；已有后续修改时会阻止回退。</span></div></button></>}<div className="callout">本版本供本机验证使用；Windows 安装与系统快捷键等平台能力仍需单独验收。</div>{info.benchmark_enabled==='true'&&<button className="primary wide" disabled={!!busy} onClick={runBenchmark}>运行性能库界面验证</button>}</>}
   {modal==='rollback'&&<><h2>回退上次导入？</h2><p>将恢复「{bank?.name}」导入前的快照。若导入后已有其他编辑，程序会阻止直接回退；请先导出备份，再处理需要撤回的题目。</p><button className="danger wide" disabled={!!busy} onClick={()=>work('正在回退版本',async()=>{await invoke('rollback_bank',{bankId});await refresh();setModal('');setNotice('已恢复导入前版本。')})}>确认回退</button></>}
  </section></div>}
 </div>
}
createRoot(document.getElementById('root')!).render(<App/>);
