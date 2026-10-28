import {AppearanceSettings} from './settings/appearance';
import {TraySettings} from './settings/tray';
import {CloudLibrary} from './cloud/library';
import {CloudLogin} from './cloud/login';
import {displayTime,recordedTime} from '../shared/intake';
import {listen} from '@tauri-apps/api/event';
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {getCurrentWebview} from '@tauri-apps/api/webview';
import {SoftwareUpdate} from './software-update';
import {cloudAccess,cloudCall,cloudInitializePersistentSession,fetchCatalog,reloadDesktopCache,startCloudWorker,type Access} from './cloud-client';
import {IntakePanel} from './intake-panel';
import {IntakeHub} from './intake-hub';
import {QuestionExport} from './question-export';
import {APP_VERSION} from './generated/client-assets';
import {copyText} from './clipboard';
import {open, save} from '@tauri-apps/plugin-dialog';
import {Search,Library,Package,Upload,Plus,ChevronRight,Settings,LogIn,Check,Copy,Edit3,Trash2,X,Lock,RefreshCw,BookOpen,History,CheckCircle2,Download,HardDrive,Layers,Keyboard,ScanText,PanelLeftClose,PanelLeftOpen,ChevronsUp,Eye} from 'lucide-react';
import './styles.css';
import {benchmarkCases,percentiles} from './benchmark';
import type {Question, Bank, Hit, Results} from './types';
import {SpeedResults, SearchMark as Mark, answerText as formatAnswer} from './speed-results';
import {DetailResults} from './detail-results';
import {QuestionExplanation} from './question-explanation';
import {animateSearchLayout} from './layout-motion';
import {fontSizes, loadPreferences, preferenceKey} from './preferences';
import {applyAppearance,systemScheme,watchSystemScheme} from './appearance';
import {resolveAppearance,type ColorScheme} from '../shared/appearance';
import type {Mode} from './preferences';
import {OcrPanel} from './ocr-panel';
import {looksLikeQuestion,readImage} from './ocr-client';
import type {OcrInput} from './ocr-client';
import {hasWordExportPermission} from '../shared/export-permission';

const kinds:Record<string,string>={single:'单选',multiple:'多选',true_false:'判断',programming:'编程'};
const blank=():Question=>({schema_version:'1.0',question_id:'',base_revision:1,type:'single',stem:'',options:['A','B','C','D'].map(key=>({key,content:''})),answer:[],external_id:'',bank:'',chapter:'',explanation:'',tags:[],difficulty:'',applicable_version:'',source_note:'',status:'unreviewed',issues:[],sources:[],attachments:[]});


function App(){
 const [preferences,setPreferences]=useState(loadPreferences);
 const [systemTheme,setSystemTheme]=useState(systemScheme);
 const [appearancePreview,setAppearancePreview]=useState<ColorScheme|null>(null);
 useEffect(()=>watchSystemScheme(setSystemTheme),[]);
 useLayoutEffect(()=>applyAppearance(preferences,systemTheme,appearancePreview),[preferences,systemTheme,appearancePreview]);
 const [mode,setMode]=useState<Mode>(preferences.mode);
 const [cloudSessionReady,setCloudSessionReady]=useState(false),[cloudAccessState,setCloudAccessState]=useState<Access|undefined>();
 const fontScale=fontSizes.find(f=>f.id===preferences.fontSize)!.scale;
 const [banks,setBanks]=useState<Bank[]>([]),[bankId,setBankId]=useState(preferences.bankId),[text,setText]=useState(''),[committed,setCommitted]=useState(''),[kind,setKind]=useState(''),[results,setResults]=useState<Results>({items:[],has_more:false,elapsed_ms:0}),[active,setActive]=useState<Hit|null>(null),[answerOpen,setAnswerOpen]=useState(true),[revision,setRevision]=useState(0);
 const [busy,setBusy]=useState(''),[notice,setNotice]=useState(''),[error,setError]=useState(''),[modal,setModal]=useState(''),[draft,setDraft]=useState<Question|null>(null),[editBank,setEditBank]=useState(''),[exportBank,setExportBank]=useState(''),[exportFormat,setExportFormat]=useState('package'),[history,setHistory]=useState<{question:Question;at:string;reason:string}[]>([]),[info,setInfo]=useState<Record<string,string>>({});
 const startupUpdate=useRef(false);
 const [intakeRecord,setIntakeRecord]=useState(''),[intakeInitial,setIntakeInitial]=useState(''),[intakeBankId,setIntakeBankId]=useState(''),[intakeManual,setIntakeManual]=useState(false),[intakeTab,setIntakeTab]=useState<'edit'|'records'>('edit'),[intakeNotice,setIntakeNotice]=useState('');
 const [dropping,setDropping]=useState(false);
 function openIntake(value='',record='',manual=false,targetBankId=''){setIntakeRecord(record);setIntakeInitial(value);setIntakeBankId(targetBankId);setIntakeManual(manual);setIntakeTab('edit');setIntakeNotice('');setModal('intake')}
 const [ocrInitial,setOcrInitial]=useState<OcrInput|null>(null);
 function openOcr(initial:OcrInput|null=null){setOcrInitial(initial);setModal('ocr')}
 const input=useRef<HTMLInputElement>(null),composing=useRef(false);
 const [exportFiltered,setExportFiltered]=useState(false);
 useEffect(()=>{const listener=listen('focus-search',()=>{if(!modal){input.current?.focus();input.current?.select();}});return()=>{void listener.then(unlisten=>unlisten());};},[modal]);
 const dropHandler=useRef<(paths:string[])=>void>(()=>{});
 const searchArea=useRef<HTMLDivElement>(null);
 const benchPending=useRef<null|((r:Results)=>void)>(null);
 const bank=banks.find(b=>b.id===bankId),detailBank=banks.find(b=>b.id===active?.bank_id),total=banks.reduce((n,b)=>n+b.count,0);
 const canWordExport=cloudSessionReady&&hasWordExportPermission(cloudAccessState);
 async function refresh(){const all=await invoke<Bank[]>('banks');setBanks(all);setRevision(r=>r+1);return all;}
 async function bankDeleted(id:string){if(bankId===id)setBankId('');if(active?.bank_id===id)setActive(null);setResults(r=>({...r,items:r.items.filter(h=>h.bank_id!==id)}));await refresh();}
 async function work<T,>(label:string,fn:()=>Promise<T>):Promise<T|undefined>{setBusy(label);setError('');try{return await fn()}catch(e){setError(String(e));return undefined}finally{setBusy('')}}
 useEffect(()=>{
  document.documentElement.style.setProperty('--font-scale',String(fontScale));
  document.documentElement.dataset.fontSize=preferences.fontSize;
  try{localStorage.setItem(preferenceKey,JSON.stringify({...preferences,mode,bankId}));}catch{/* A full disk must not stop offline search. */}
 },[preferences,mode,bankId,fontScale]);
 useEffect(()=>{if(banks.length&&((bankId&&!banks.some(b=>b.id===bankId))||(mode==='speed'&&!bankId)))setBankId(banks[0].id)},[banks,bankId,mode]);
 useEffect(()=>startCloudWorker(()=>{void refresh()},setNotice),[]);
 useEffect(()=>{let mounted=true;const syncAccess=()=>setCloudAccessState(cloudAccess());window.addEventListener('qbank-cloud-access-change',syncAccess);void cloudInitializePersistentSession().catch(()=>{}).finally(()=>{if(mounted){syncAccess();setCloudSessionReady(true)}});return()=>{mounted=false;window.removeEventListener('qbank-cloud-access-change',syncAccess)};},[]);
 useEffect(()=>{if(!canWordExport&&exportFormat.startsWith('docx'))setExportFormat('package');if(!canWordExport&&modal==='question-export')setModal('')},[canWordExport,exportFormat,modal]);
 useEffect(()=>{work('正在打开本地题库',async()=>{await refresh();setInfo(await invoke('app_info'));});},[]);
 useEffect(()=>{if(!info.version||busy||startupUpdate.current)return;startupUpdate.current=true;void invoke<{configured:boolean;version?:string}>('software_update_check').then(result=>{if(result.version)setNotice(`软件有新版本 ${result.version}，可在设置中查看并安装。`);}).catch(()=>{});},[info.version,busy]);
 useEffect(()=>{const handle=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.shiftKey&&e.key.toLowerCase()==='o'&&!modal){e.preventDefault();openOcr();return}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'&&!modal){e.preventDefault();input.current?.focus();input.current?.select();}if(e.key==='Escape'){if(modal&&!busy){setModal('');setDraft(null)}else{input.current?.focus();}}};window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);},[results,active,modal,busy]);
 useEffect(()=>{const paste=(e:ClipboardEvent)=>{if(modal||busy||!e.clipboardData)return;const item=Array.from(e.clipboardData.items).find(i=>i.type.startsWith('image/'));if(item){const file=item.getAsFile();if(file){e.preventDefault();readImage(file).then(image=>openOcr({image})).catch(e=>setError(String(e)))}return}const value=e.clipboardData.getData('text/plain');if(value.includes('qbank-photo-question-1')){e.preventDefault();openIntake(value);return}if(looksLikeQuestion(value)){e.preventDefault();openOcr({text:value})}};window.addEventListener('paste',paste);return()=>window.removeEventListener('paste',paste)},[modal,busy]);
 useEffect(()=>{if(benchPending.current){requestAnimationFrame(()=>requestAnimationFrame(()=>{const done=benchPending.current;benchPending.current=null;done?.(results)}));}},[results]);
 useEffect(()=>{if(notice){const t=setTimeout(()=>setNotice(''),8000);return()=>clearTimeout(t)}},[notice]);
 function switchMode(next:Mode){
  if(next==='speed'&&!bankId)setBankId(active?.bank_id||banks[0]?.id||'');
  setMode(next);setError('');setNotice('');
  requestAnimationFrame(()=>input.current?.focus());
 }
 function switchBank(id:string){setBankId(id)}
 function openExport(format='package'){setExportBank(bankId||active?.bank_id||banks[0]?.id||'');setExportFormat(format);setModal('export')}
 async function doExport(){if(exportFormat.startsWith('docx')&&!canWordExport)return;await work('正在制作文件，请稍候',async()=>{const b=banks.find(b=>b.id===exportBank);if(!b)throw Error('请选择题库');const ext=exportFormat==='package'?'qbank.zip':exportFormat.startsWith('docx')?'docx':exportFormat;const path=await save({title:exportFormat==='package'?'制作离线题库包':'导出题库',defaultPath:`${await invoke<string>('export_name',{bankId:exportBank})}.${ext}`,filters:[{name:ext,extensions:exportFormat==='package'?['zip']:[ext]}]});if(!path)return;const count=await invoke<number>('export_bank',{bankId:exportBank,path,format:exportFormat,filter:exportFiltered&&exportFormat!=='package'?{text:committed,kind,bank_id:exportBank}:null});setModal('');setNotice(`已保存 ${count.toLocaleString()} 题：${path}`);})}
 async function doQuestionExport(targetBank:string,startAt:string|null,endBefore:string|null,revisions:number[]=[]){if(!canWordExport)return;await work('正在准备 DOCX 题目文件',async()=>{
  const selectedBank=banks.find(item=>item.id===targetBank);if(!selectedBank)throw Error('请选择题库');
  if(revisions.length){
   const batches=await Promise.all(revisions.map(revision=>cloudCall<{revision:number;added_count:number;questions:Question[]}>(`/v1/banks/${targetBank}/history/${revision}/questions`,undefined,true)));
   const questions=batches.flatMap(batch=>batch.questions||[]),expected=batches.reduce((count,batch)=>count+(batch.added_count||0),0);
   if(!questions.length||questions.length!==expected)throw Error('云端没有返回完整的所选修订新增题目');
   const now=new Date(),pad=(value:number)=>String(value).padStart(2,'0'),stamp=`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
   const simpleBankName=selectedBank.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/\s+/g,'_').replace(/^[_ .-]+|[_ .-]+$/g,'').slice(0,48)||'题库';
   const path=await save({title:'导出修订新增题目',defaultPath:`${simpleBankName}_${stamp}_${expected}题_修订${revisions.join('-')}.docx`,filters:[{name:'Word 文档',extensions:['docx']}]});
   if(!path)return;
   const exported=await invoke<number>('export_remote_questions',{questions,path});setModal('');setNotice(`已导出 ${exported.toLocaleString()} 道题：${path}`);return;
  }
  const count=await invoke<number>('count_recorded_questions',{bankId:targetBank,startAt,endBefore});
  if(!count)throw Error('所选范围内没有可导出的题目');
  const now=new Date(),pad=(value:number)=>String(value).padStart(2,'0');
  const stamp=`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const simpleBankName=selectedBank.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/\s+/g,'_').replace(/^[_ .-]+|[_ .-]+$/g,'').slice(0,48)||'题库';
  const scopeLabel=startAt&&endBefore?'部分导出':'全部导出';
  const defaultPath=`${simpleBankName}_${stamp}_${count}题_${scopeLabel}.docx`;
  const path=await save({title:'导出题目',defaultPath,filters:[{name:'Word 文档',extensions:['docx']}]});
  if(!path)return;
  const exported=await invoke<number>('export_recorded_questions',{bankId:targetBank,path,startAt,endBefore});
  setModal('');setNotice(`已导出 ${exported.toLocaleString()} 道题：${path}`);
 })}
 async function clearAndReloadCloudCache(){await work('正在删除本地题库缓存并重新下载',async()=>{
  const cached=await invoke<{bank_id:string;revision:number;sha256:string}[]>('cloud_versions');
  const localIds=[...new Set(cached.map(item=>item.bank_id).filter(id=>banks.some(bank=>bank.id===id&&bank.read_only)))];
  if(!localIds.length){setNotice('当前没有已下载的云端题库缓存。');return}
  const catalog=await fetchCatalog(),manifests=new Map(catalog.map(manifest=>[manifest.bank_id,manifest]));
  const targets=localIds.filter(id=>manifests.has(id)),skipped=localIds.length-targets.length;
  if(!targets.length){setNotice('云端目录中未找到本机缓存的题库；现有本地题目保持不变。');return}
  if(!window.confirm(`将清除并重新下载 ${targets.length} 个本机云端题库缓存。新快照校验通过后才会替换现有发布内容；本地自建题库、录题草稿和待上传内容会保留。${skipped?`另有 ${skipped} 个本地缓存题库不在当前云端目录，将保持不变。`:''}确定继续？`))return;
  const results=await Promise.allSettled(targets.map(id=>reloadDesktopCache(id,manifests.get(id)!)));
  await refresh();
  const succeeded=results.filter(result=>result.status==='fulfilled').length;
  const failed=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
  setNotice(`缓存重载完成：${succeeded}/${targets.length} 个云端题库已重新下载并校验。${skipped?` ${skipped} 个不在目录中的缓存未改动。`:''}${failed.length?` 失败 ${failed.length} 个：${String(failed[0].reason)}`:''}`);
 })}
 async function importDelta(path:string){
  const result=await invoke<{bank_id:string;name:string;added:number;skipped:number;conflicts:number}>('import_delta',{path});
  await refresh();switchBank(result.bank_id);
  setIntakeRecord('');setIntakeInitial('');setIntakeManual(false);setIntakeTab('records');
  setIntakeNotice(`「${result.name}」新增 ${result.added} 题，跳过 ${result.skipped} 道重复题${result.conflicts?`；${result.conflicts} 道答案或 ID 不一致，已保留现有题目`:''}。`);
  setModal('intake');
 }
 dropHandler.current=(paths)=>{
  if(!paths.some(p=>p.toLowerCase().endsWith('.json')))return;
  if(busy||(modal&&modal!=='intake-hub')){setError('请先关闭当前页面，再拖入 JSON 增量题库文件。');return}
  if(paths.length!==1||!paths[0].toLowerCase().endsWith('.json')){setError('请一次拖入一个 .json 增量题库文件。');return}
  void work('正在合并 JSON 增量题库',()=>importDelta(paths[0]));
 };
 useEffect(()=>{
  if(!isTauri())return;let disposed=false;let unlisten:(()=>void)|undefined;
  getCurrentWebview().onDragDropEvent(event=>{
   if(event.payload.type==='drop'){setDropping(false);dropHandler.current(event.payload.paths)}
   else if(event.payload.type==='enter')setDropping(event.payload.paths.some(p=>p.toLowerCase().endsWith('.json')));
   else if(event.payload.type==='leave')setDropping(false);
  }).then(fn=>{if(disposed)fn();else unlisten=fn}).catch(()=>setError('JSON 拖放不可用，请在“录题与导入”中选择 JSON 文件。'));
  return()=>{disposed=true;unlisten?.()};
 },[]);
 async function chooseJsonImport(){await work('正在导入 JSON 增量题库',async()=>{const path=await open({multiple:false,title:'导入 JSON 增量题库',filters:[{name:'JSON 增量题库',extensions:['json']}]});if(!path||Array.isArray(path))return;await importDelta(path);})}
 function beginManualEntry(selectedBankId:string){const target=banks.find(b=>b.id===selectedBankId)||banks.find(b=>b.id===bankId)||banks.find(b=>b.id===active?.bank_id)||banks.find(b=>!b.read_only);if(!target){setError('请先在题库管理中创建一个题库。');setModal('library');return;}switchBank(target.id);openIntake('', '', true, target.id)}
 async function fork(id:string){await work('正在建立可编辑副本',async()=>{const newId=await invoke<string>('fork_bank',{bankId:id});await refresh();switchBank(newId);setModal('');setNotice('副本已建立；来源信息已保留。')})}
 async function edit(hit:Hit){try{const records=await invoke<import('../shared/draft').DraftRecord[]>('draft_records',{bankId:hit.bank_id});if(records.some(r=>r.id===hit.question.question_id)){switchBank(hit.bank_id);openIntake('',hit.question.question_id);return;}setEditBank(hit.bank_id);setDraft(structuredClone(hit.question));setModal('edit')}catch(e){setError(String(e))}}
 async function saveDraft(){if(!draft)return;await work('正在保存题目',async()=>{await invoke('save_question',{bankId:editBank,question:draft});await refresh();switchBank(editBank);setModal('');setDraft(null);setNotice('题目已保存，搜索索引已同步更新。')})}
 async function deleteActive(){if(!active||!window.confirm('确认永久删除这道题？此操作不可撤销。'))return;await work('正在删除题目',async()=>{await invoke('delete_question',{rowid:active.rowid});await refresh();setModal('');setNotice('题目已删除。')})}
 async function copy(){if(!active)return;const q=active.question;try{await copyText(`${q.stem}\n${q.options.map(o=>o.key+'. '+o.content).join('\n')}\n答案：${formatAnswer(q)}${q.explanation?'\n解析：'+q.explanation:''}`);setNotice('题目与答案已复制。')}catch{setError('无法访问剪贴板，请选中文字复制。')}}
 async function runBenchmark(){await work('正在验证界面响应',async()=>{
  const b=banks.find(b=>b.name.startsWith('性能验证 ·'));if(!b)throw Error('请使用 qbank-tool 生成的独立性能验证库');
  const cases=benchmarkCases(b.count,b.id),samples:{round:number;case:number;text:string;ui_ms:number;core_ms:number;rows:number}[]=[];
  setModal('');setAnswerOpen(true);
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
  const report={at:new Date().toISOString(),questions:b.count,query_cases:200,query_suite:mode==='speed'?'v2-mixed-speed-all-types-selected-bank':'v2-mixed',mode,font_size:preferences.fontSize,theme:resolveAppearance(preferences,systemTheme).theme,color_scheme:resolveAppearance(preferences,systemTheme).scheme,rounds:3,ui_ms:percentiles(samples.map(s=>s.ui_ms)),core_ms:percentiles(samples.map(s=>s.core_ms)),measures:'React search state to two animation frames after results commit; includes IPC, SQLite and UI; excludes physical keyboard dispatch; OS cache uncontrolled',info,samples};
  const path=await invoke<string>('save_benchmark',{report});setNotice(`界面验证完成：P95 ${report.ui_ms.p95.toFixed(1)} ms；${path}`);
 })}
 const q=active?.question;
 const modeSwitch=<div className="mode-switch" role="group" aria-label="页面模式">{([['detail','详细模式'],['speed','极速模式']] as const).map(([value,label])=><button key={value} aria-pressed={mode===value} className={mode===value?'active':''} onClick={()=>switchMode(value)}>{label}</button>)}</div>;
 const searchBox=<div className="search-box"><Search size={22}/><input ref={input} autoFocus aria-label={mode==='speed'?`搜索当前题库：${bank?.name||'正在载入'}`:'搜索题目'} placeholder={mode==='speed'?`搜索「${bank?.name||'当前题库'}」中的全部题目…`:'搜索题目、选项、标签、章节或编号…'} value={text} onChange={e=>{setText(e.target.value);if(!composing.current){setCommitted(e.target.value)}}} onCompositionStart={()=>{composing.current=true}} onCompositionEnd={e=>{composing.current=false;setCommitted(e.currentTarget.value)}}/>{text?<button aria-label="清空搜索" onClick={()=>{setText('');setCommitted('');input.current?.focus()}}><X size={17}/></button>:mode==='detail'?<kbd>⌘ / Ctrl K</kbd>:null}<button className="ocr-search-entry" title="截图 / 粘贴识题（⌘ / Ctrl Shift O）" aria-label="截图或粘贴识题" onClick={()=>openOcr()}><ScanText size={19}/></button></div>;
 return <div className={`app ${mode==='speed'?'speed-mode':''}`}>
  {mode==='detail'&&<div id="workspace-sidebar" className={`sidebar-shell ${preferences.sidebarCollapsed?'is-collapsed':''}`} aria-hidden={preferences.sidebarCollapsed} inert={preferences.sidebarCollapsed}><aside className="sidebar">
   <div className="brand"><div className="brand-mark"><Layers size={24}/></div><div className="brand-name"><b>题库</b><small>离线知识工作台</small></div></div>
   <button className={`nav-item ${!bankId?'selected':''}`} onClick={()=>switchBank('')}><Library size={18}/>全部题目 <span>{total.toLocaleString()}</span></button>
   <section className="sidebar-library" aria-label="题库列表">
   <div className="section-label">题库</div>
   <nav className="bank-nav" aria-label="切换题库">{banks.map(b=><button className={`bank-item ${bankId===b.id?'selected':''}`} key={b.id} onClick={()=>switchBank(b.id)}><span className={`bank-dot ${b.read_only?'readonly':''}`}/><div><b title={b.name}>{b.name}</b><small>{b.read_only?'发布题库':'可编辑'} · {b.count.toLocaleString()} 题{b.read_only&&<Lock className="bank-lock" size={12} aria-hidden="true"/>}</small></div></button>)}</nav>
   <button className="nav-item" onClick={()=>setModal('library')}><Library size={17}/>题库管理</button>
   </section>
   <div className="nav-divider"/>
   <nav className="sidebar-tools" aria-label="工具与设置">
    <button className="nav-item cloud-login-entry" onClick={()=>setModal('cloud-login')}><LogIn size={17}/>云端登录</button>
    <button className="nav-item settings" onClick={()=>setModal('settings')}><Settings size={17}/>设置与维护 <span>v{APP_VERSION}</span></button>
   </nav>
   <div className="local-status"><i/> 数据保存在本机</div>
  </aside></div>}
  <main>
   {mode==='speed'?<>
    <header className="speed-header"><div className="speed-tools"><button className="speed-settings" title="设置与维护" aria-label="设置与维护" onClick={()=>setModal('settings')}><Settings size={19}/></button><button className="speed-cloud-login" title="云端登录" aria-label="云端登录" onClick={()=>setModal('cloud-login')}><LogIn size={18}/></button><button className="speed-preview-toggle" title={preferences.speedPreview?'关闭题目预览':'开启题目预览：鼠标移入题目立即显示'} aria-label="题目预览" aria-pressed={preferences.speedPreview} onClick={()=>setPreferences(p=>({...p,speedPreview:!p.speedPreview}))}><Eye size={18}/><span>预览</span></button></div>{searchBox}{modeSwitch}</header>
    <SpeedResults bankId={bankId||'__no_selected_bank__'} query={committed} revision={revision} fontScale={fontScale} previewEnabled={preferences.speedPreview&&!modal&&!busy} onResults={setResults}/>
   </>:<>

   <header className="topbar"><button className="sidebar-toggle" aria-label={preferences.sidebarCollapsed?'展开侧栏':'收起侧栏'} title={preferences.sidebarCollapsed?'展开侧栏':'收起侧栏'} aria-expanded={!preferences.sidebarCollapsed} aria-controls="workspace-sidebar" onClick={()=>setPreferences(p=>({...p,sidebarCollapsed:!p.sidebarCollapsed}))}>{preferences.sidebarCollapsed?<PanelLeftOpen size={18}/>:<PanelLeftClose size={18}/>}</button><div className="breadcrumb">工作空间 <ChevronRight size={13}/> <b>{bank?.name||'全部题目'}</b></div>{modeSwitch}<div className="top-actions"><button onClick={()=>setModal('intake-hub')}><Upload size={16}/>录题与导入</button><button className="primary" onClick={()=>openExport()}><Package size={16}/>制作离线包</button></div></header>
   <div className="search-area-shell" ref={searchArea} role="region" aria-label="搜索与筛选"><section id="detail-search-area" className={`search-area ${preferences.searchCollapsed?'is-collapsed':''}`}><div className="title-line"><div><h1>{bank?.name||'全部题目'}</h1><p>{bank?`${bank.count.toLocaleString()} 道题目 · 版本 v${bank.version} · ${new Date(bank.updated_at).toLocaleDateString()} · ${bank.read_only?'已导入的发布快照':'在本机维护与发布'}`:'输入题干片段、中文关键词或 API 名，直接搜索本机题库。'}</p></div><div className="library-stat"><strong>{(bank?.count??total).toLocaleString()}</strong><small>本地题目</small></div></div>
   {searchBox}
   <div className="filter-row">{preferences.searchCollapsed?<select className="compact-kind" aria-label="筛选题型" value={kind} onChange={e=>{setKind(e.target.value)}}>{[['','全部题型'],...Object.entries(kinds)].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>:<div className="segmented">{[['','全部题型'],...Object.entries(kinds)].map(([value,label])=><button key={value} className={kind===value?'active':''} onClick={()=>{setKind(value)}}>{label}</button>)}</div>}<div className="search-actions"><span className="search-meta">{results.elapsed_ms.toFixed(1)} ms 查询 · 连续滚动</span><button className="search-collapse-toggle" aria-label={preferences.searchCollapsed?'展开搜索区':'收起搜索区'} title={preferences.searchCollapsed?'展开搜索区':'收起搜索区'} aria-expanded={!preferences.searchCollapsed} aria-controls="detail-search-area" onClick={()=>animateSearchLayout(searchArea.current,()=>setPreferences(p=>({...p,searchCollapsed:!p.searchCollapsed})))}><ChevronsUp size={15}/><span>{preferences.searchCollapsed?'展开':'收起搜索区'}</span></button></div></div></section>
   </div>
   <div className="content-grid"><DetailResults bankId={bankId} query={committed} kind={kind} revision={revision} fontScale={fontScale} active={active} keyboardEnabled={!modal} onSelect={hit=>{setActive(hit);setAnswerOpen(true)}} onResults={(result,initial)=>{setResults(result);if(initial)setActive(old=>result.items.find(hit=>hit.rowid===old?.rowid)||result.items[0]||null)}}/>
   <section className="detail-pane">{q&&active?<><div className="detail-toolbar"><span>题目详情</span><div><button title="复制题目与答案" aria-label="复制题目与答案" onClick={copy}><Copy size={16}/></button><button title="修订历史" aria-label="修订历史" onClick={()=>work('正在读取历史',async()=>{setHistory(await invoke('history',{bankId:active.bank_id,questionId:q.question_id}));setModal('history')})}><History size={16}/></button>{!detailBank?.read_only&&<><button aria-label="编辑题目" title="编辑题目" onClick={()=>edit(active)}><Edit3 size={16}/></button><button aria-label="删除题目" title="删除题目" onClick={()=>void deleteActive()}><Trash2 size={16}/></button></>}</div></div><div className="detail-scroll"><div className="detail-meta"><span className={`type-badge ${q.type}`}>{kinds[q.type]}</span><span>{q.external_id||'自建题目'}</span><span className="detail-revision">修订 {q.base_revision}</span></div>{q.type==='programming'?<pre className="programming-stem"><Mark text={q.stem} query={committed}/></pre>:<h2><Mark text={q.stem} query={committed}/></h2>}<div className="choices">{q.options.map(o=><div key={o.key} className={`choice ${answerOpen&&Array.isArray(q.answer)&&q.answer.includes(o.key)?'correct':''}`}><span className="choice-key">{o.key}</span><p><Mark text={o.content} query={committed}/></p>{answerOpen&&Array.isArray(q.answer)&&q.answer.includes(o.key)&&<Check size={16}/>}</div>)}</div><div className="answer-card"><div className="answer-heading"><span><CheckCircle2 size={16}/>参考答案</span><button onClick={()=>setAnswerOpen(!answerOpen)}>{answerOpen?'收起':'显示答案'}</button></div>{answerOpen&&<><strong>{formatAnswer(q)}</strong><QuestionExplanation question={q} className="explanation"/></>}</div>{detailBank?.read_only&&<div className="readonly-note"><Lock size={14}/><span>发布版本 v{detailBank.version}，可直接再次制包。</span><button onClick={()=>fork(detailBank.id)}>建立可编辑副本</button></div>}<div className="question-footer"><div><span>录入时间</span><b>{displayTime(recordedTime(q))}{q.recorded_at_source==='import'?'（导入）':''}</b></div><div><span>题库</span><b>{active.bank_name}</b></div>{q.chapter&&<div><span>章节</span><b>{q.chapter}</b></div>}{q.tags.length>0&&<div><span>标签</span><b>{q.tags.join(' / ')}</b></div>}{q.applicable_version&&<div><span>适用版本</span><b>{q.applicable_version}</b></div>}</div></div></>:<div className="empty detail-empty"><BookOpen size={44}/><b>从左侧选择一道题</b><p>答案、选项与解析会显示在这里。</p></div>}</section></div>
   <footer className="statusbar"><span><HardDrive size={13}/> 本地索引已就绪</span><span><Keyboard size={13}/> Alt ↑ ↓ 切换题目 · ⌘ / Ctrl K 搜索</span></footer>
   </>}
  </main>
  {(notice||error)&&<div className={`toast ${error?'error':''}`} role={error?'alert':'status'}><span>{error||notice}</span><button aria-label="关闭提示" onClick={()=>{setError('');setNotice('')}}><X size={16}/></button></div>}
  {busy&&<div className="busy" role="status"><RefreshCw size={16} className="spin"/>{busy}</div>}
  {dropping&&<div className="delta-drop-overlay">松开即可导入 JSON 增量题库<br/><small>按题库身份合并 · 自动跳过重复题</small></div>}
  {modal==='library'&&<CloudLibrary banks={banks} onClose={()=>setModal('')} onChanged={refresh} onDeleted={bankDeleted} onCreated={switchBank}/>}
  {modal==='intake-hub'&&<IntakeHub busy={!!busy} bankId={bankId||active?.bank_id||''} showExport={canWordExport} onAI={selectedBankId=>openIntake('', '', false, selectedBankId)} onManual={selectedBankId=>beginManualEntry(selectedBankId)} onJSON={()=>void chooseJsonImport()} onExport={()=>{if(canWordExport)setModal('question-export')}} onClose={()=>setModal('')}/>}
  {modal==='question-export'&&canWordExport&&<QuestionExport banks={banks} defaultBankId={bankId||active?.bank_id||banks[0]?.id||''} busy={!!busy} onClose={()=>setModal('')} onExport={(id,startAt,endBefore,revisions)=>void doQuestionExport(id,startAt,endBefore,revisions)}/>}
  {modal==='intake'&&<IntakePanel banks={banks} bankId={intakeBankId||bankId||active?.bank_id||''} initial={intakeInitial} initialRecordId={intakeRecord} startManual={intakeManual} initialTab={intakeTab} initialNotice={intakeNotice} onClose={()=>setModal('')} onBusy={value=>setBusy(value?'正在处理录入':'')} onSaved={async id=>{await refresh();switchBank(id)}}/>}
  {modal==='ocr'&&<OcrPanel banks={banks} bankId={bankId||active?.bank_id||''} initial={ocrInitial} onClose={()=>setModal('')} onSearch={(value,id)=>{setModal('');switchBank(id);setText(value);setCommitted(value);input.current?.focus()}}/>}
  {modal&&modal!=='library'&&modal!=='ocr'&&modal!=='intake'&&modal!=='intake-hub'&&modal!=='question-export'&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy){setModal('');setDraft(null)}}}><section className={`modal ${modal==='edit'||modal==='cloud-login'?'large':''} ${modal==='settings'?'settings-modal':''} ${modal==='cloud-login'?'cloud-login-modal':''}`} role="dialog" aria-modal="true" aria-label={modal==='cloud-login'?'云端登录与权限':undefined}><button className="close-modal" aria-label="关闭" disabled={!!busy} onClick={()=>{setModal('');setDraft(null)}}><X size={20}/></button>
   {modal==='cloud-login'&&<CloudLogin/>}
   {modal==='export'&&<><div className="modal-icon"><Package/></div><h2>{exportFormat==='package'?'制作离线题库包':'导出题库'}</h2><p>离线包包含整库题目、答案、来源和版本，适合备份或外部传递；当前客户端不提供离线包回导。</p><label>选择题库<select value={exportBank} onChange={e=>setExportBank(e.target.value)}>{banks.map(b=><option key={b.id} value={b.id}>{b.release_name||b.name} · {b.count} 题 · v{b.version}</option>)}</select></label><label>文件格式<select value={exportFormat} onChange={e=>setExportFormat(e.target.value)}><option value="package">离线题库包（.qbank.zip）</option><option value="xlsx">标准 Excel（.xlsx）</option>{canWordExport&&<option value="docx">标准 Word（.docx）</option>}<option value="jsonl">标准 JSONL（.jsonl）</option>{canWordExport&&<><option value="docx-study">Word 学习版（含答案解析）</option><option value="docx-exam">Word 试卷版（无答案）</option><option value="docx-answers">Word 独立答案版</option></>}</select></label><label><input type="checkbox" checked={exportFiltered&&exportFormat!=='package'} disabled={exportFormat==='package'} onChange={e=>setExportFiltered(e.target.checked)}/>仅导出当前搜索与筛选结果（所选题库）</label><div className="callout">Word 打印文档需要 Word 导出权限。需要改动离线库时，在题库管理中建立可编辑副本，再用 JSON 增量合并新题。</div><button className="primary wide" disabled={!exportBank||!!busy} onClick={doExport}><Download size={17}/>选择位置并保存</button></>}
   {modal==='edit'&&draft&&draft.question_id&&<><h2>编辑题目</h2><p>修改题目内容与答案，保存后立即更新搜索。</p><p className="muted">题库：{banks.find(b=>b.id===editBank)?.release_name||banks.find(b=>b.id===editBank)?.name||editBank}</p><div className="form-grid"><label>题型<select value={draft.type} onChange={e=>setDraft({...draft,type:e.target.value,answer:e.target.value==='true_false'?true:e.target.value==='programming'?null:[],options:e.target.value==='true_false'||e.target.value==='programming'?[]:draft.options.length?draft.options:blank().options})}>{Object.entries(kinds).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label><label>外部编号<input value={draft.external_id} onChange={e=>setDraft({...draft,external_id:e.target.value})} placeholder="可选"/></label><label>章节<input value={draft.chapter} onChange={e=>setDraft({...draft,chapter:e.target.value})} placeholder="开发基础/组件"/></label></div><label>题干<textarea rows={4} value={draft.stem} onChange={e=>setDraft({...draft,stem:e.target.value})}/></label>{draft.type==='programming'?<p className="programming-editor-note">编程题正文直接填写在题干中，暂无标准答案。</p>:draft.type!=='true_false'?<><div className="options-editor">{draft.options.map((o,i)=><div key={o.key}><span>{o.key}</span><textarea rows={2} value={o.content} onChange={e=>setDraft({...draft,options:draft.options.map((v,j)=>i===j?{...v,content:e.target.value}:v)})}/><input type={draft.type==='single'?'radio':'checkbox'} name="correct" aria-label={`${o.key} 为正确答案`} checked={Array.isArray(draft.answer)&&draft.answer.includes(o.key)} onChange={e=>setDraft({...draft,answer:draft.type==='single'?[o.key]:e.target.checked?[...(Array.isArray(draft.answer)?draft.answer:[]),o.key].sort():(Array.isArray(draft.answer)?draft.answer:[]).filter(k=>k!==o.key)})}/></div>)}</div><div className="option-tools"><button disabled={draft.options.length>=8} onClick={()=>setDraft({...draft,options:[...draft.options,{key:'ABCDEFGH'[draft.options.length],content:''}]})}><Plus size={14}/>添加选项</button><button disabled={draft.options.length<=2} onClick={()=>{const last=draft.options.at(-1)?.key;setDraft({...draft,options:draft.options.slice(0,-1),answer:(Array.isArray(draft.answer)?draft.answer:[]).filter(a=>a!==last)})}}>移除末项</button><span>右侧勾选正确答案</span></div></>:<label>答案<select value={draft.answer===null?"":String(draft.answer)} onChange={e=>setDraft({...draft,answer:e.target.value==='true'})}><option value="" disabled>请选择答案</option><option value="true">正确</option><option value="false">错误</option></select></label>}<label>解析<textarea rows={3} value={draft.explanation} onChange={e=>setDraft({...draft,explanation:e.target.value})}/></label><div className="form-grid"><label>标签（用 | 分隔）<input value={draft.tags.join('|')} onChange={e=>setDraft({...draft,tags:e.target.value.split('|')})}/></label><label>答案状态<select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value,issues:e.target.value==='verified'?[]:draft.issues})}><option value="unreviewed">按来源录入</option><option value="verified">已核对正确</option><option value="needs_review">留待核对</option></select></label></div><button className="primary wide" disabled={!!busy||!banks.some(b=>b.id===editBank&&!b.read_only)} onClick={saveDraft}>保存题目</button></>}
   {modal==='history'&&<><h2>修订历史</h2><p>恢复历史内容会新增修订，不会抹去后续记录。</p>{history.length?history.map((h,i)=><div className="history-item" key={i}><b>{h.reason} · 修订 {h.question.base_revision}</b><small>{new Date(h.at).toLocaleString()}</small><p>{h.question.stem.slice(0,160)}</p>{!detailBank?.read_only&&<button onClick={()=>{setDraft({...h.question,base_revision:q!.base_revision});setEditBank(active!.bank_id);setModal('edit')}}>载入编辑器</button>}</div>):<div className="callout">这道题还没有历史修订。</div>}</>}
   {modal==='settings'&&<><div className="settings-modal-heading"><div className="modal-icon"><Settings/></div><div><h2>设置与维护</h2><p>题库 v{info.version||APP_VERSION} · {info.platform} / {info.arch}</p></div></div>
    <AppearanceSettings preferences={preferences} setPreferences={setPreferences} systemTheme={systemTheme} setPreview={setAppearancePreview}/>
    <TraySettings available={info.tray==='true'}/>
    <section className="settings-maintenance" aria-labelledby="settings-maintenance-title">
     <h3 id="settings-maintenance-title">备份与维护</h3>
     <div className="settings-backup-actions">
      <button className="template-card" disabled={!!busy} onClick={()=>void work('正在创建一致性备份',async()=>{const path=await save({defaultPath:'题库备份.sqlite',filters:[{name:'完整题库备份',extensions:['sqlite']}]});if(!path)return;const n=await invoke<number>('backup_database',{path,restore:false});setNotice(`已备份 ${n} 道题及修订记录：${path}`);})}>保存完整数据库备份</button>
      <button className="template-card" disabled={!!busy} onClick={()=>void work('正在校验并恢复备份',async()=>{const path=await open({multiple:false,filters:[{name:'完整题库备份',extensions:['sqlite']}]});if(typeof path!=='string')return;if(!window.confirm('将用所选备份替换本机全部题库和修订记录。当前数据库会先自动备份，确认恢复？'))return;await invoke('backup_database',{path,restore:true});setActive(null);await refresh();setNotice('备份已校验并恢复；恢复前的数据库保存在 backups 目录。')})}>校验并恢复完整备份</button>
      <button className="template-card" disabled={!!busy} onClick={()=>void clearAndReloadCloudCache()}>删除本地题库缓存</button>
     </div>
     <SoftwareUpdate busy={!!busy} onBusy={value=>setBusy(value?'正在安装软件更新':'')}/>
     <div className="settings-maintenance-runtime">
      <p>全局唤起：{info.global_shortcut} · 托盘{info.tray==='true'?'已启用，关闭窗口后仍可唤起':'不可用'}</p>
      <div className="settings-maintenance-database"><span>本地数据库</span><code className="db-path" title={info.database}>{info.database}</code></div>
     </div>
     <button className="template-card settings-index-action" disabled={!!busy} onClick={()=>work('正在重建搜索索引',async()=>{await invoke('rebuild_index');setNotice('搜索索引已重建。');setRevision(r=>r+1)})}><RefreshCw/><div className="settings-index-copy"><b>重建搜索索引</b><span>题目内容保持不变。</span></div></button>
    </section>
    {info.benchmark_enabled==='true'&&<button className="primary wide" disabled={!!busy} onClick={runBenchmark}>运行性能库界面验证</button>}</>}
  </section></div>}
 </div>
}
createRoot(document.getElementById('root')!).render(<App/>);
