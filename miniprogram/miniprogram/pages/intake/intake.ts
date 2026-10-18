import {activeBankId,listBanks,selectBank,createBank,loadBank,invalidateBank} from '../../services/bank';
import {syncBank} from '../../services/sync';
import {readLocal,updateLocal} from '../../services/intake-store';
import {editReply,saveReply,exportBatch,importDelta} from '../../services/intake';
import {cloud} from '../../services/cloud';
import {enqueueBatches,runUploadQueue,retryUploads,pauseUploads} from '../../services/cloud-intake';
import {copyPrompt} from '../../services/prompt';
import {APP_VERSION} from '../../generated/client-assets';
import {answerText} from '../../core/search';
import {parseDraft,emptyReply,toggleAnswer,replyFromQuestion,recordedTime,displayTime,parseModelReply,reorderOptions,changeQuestionType,editedReplyText,intakeMetadata,type ModelReply} from '../../core/intake';
type BatchRow={id:string;label:string};
type EntryRow={recordedAt:string;editable:boolean;id:string;stem:string;answer:string;uploadStatus:string;statusLabel:string};
type ShareAPI={shareFileMessage?:(o:{filePath:string;fileName:string;success:()=>void;fail:(e:{errMsg:string})=>void})=>void};
function localTime(value:string){const d=new Date(value);if(!Number.isFinite(d.getTime()))return value;
 const two=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${two(d.getMonth()+1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;}
Page({
 data:{reviewSignature:'',reviewBank:'',reviewRows:[] as {id:string;stem:string;options:{key:string;content:string}[];answer:string;explanation:string;recordedAt:string}[],saved:'',editing:'',recordedAt:'',hasPrevious:false,jobLabels:[] as string[],appVersion:APP_VERSION,banks:[] as {id:string;name:string}[],bankIndex:0,bankId:'',text:'',
  batches:[{id:'',label:'本次新批次'}] as BatchRow[],batchIndex:0,batchId:'',entries:[] as EntryRow[],
  metadata:intakeMetadata(),tagsText:'',difficulties:['未设置','简单','中等','困难'],difficultyIndex:0,boolSelected:false,original:'',types:['单选','多选','判断'],typeIndex:0,versionSources:['平台提供','用户提供','未知'],sourceIndex:0,editOptions:[] as {key:string;content:string;correct:boolean}[],warningsText:'',reply:null as ModelReply|null,status:'',answer:'',existingAnswers:[] as string[],busy:false,error:'',notice:'',filePath:'',fileName:'',
  cloudConfigured:false,loggedIn:false,authorizedBank:false,uploadsEnabled:false,uploadBlocked:false,authorizedNames:'',uploadStarted:false,receiptId:'',acceptedAt:''},
 alive:true,locked:false,refreshTimer:undefined as ReturnType<typeof setInterval>|undefined,writes:Promise.resolve() as Promise<unknown>,
 async onLoad(params:Record<string,string|undefined>){this.setData({bankId:params.bank||activeBankId()});await this.run(async()=>{await this.restoreDraft();await this.refresh()});},
 onShow(){this.refreshAuth();if(this.data.banks.length)void this.run(()=>this.refresh());if(this.refreshTimer!==undefined)clearInterval(this.refreshTimer);this.refreshTimer=setInterval(()=>{if(!this.locked&&this.data.banks.length)void this.refresh().catch(()=>{})},3000)},
 onHide(){if(this.refreshTimer!==undefined)clearInterval(this.refreshTimer);void this.persistDraft().catch(()=>{})},
 onUnload(){if(this.refreshTimer!==undefined)clearInterval(this.refreshTimer);void this.persistDraft().catch(()=>{});this.alive=false},
 async persistDraft(){const bankId=this.data.bankId;if(!bankId)return;const current={text:this.data.text,reply:this.data.reply,original:this.data.original,metadata:this.data.metadata,batchId:this.data.batchId,editing:this.data.editing,recordedAt:this.data.recordedAt};
  this.writes=updateLocal(d=>{d.drafts=d.drafts||{};d.drafts[bankId]={...d.drafts[bankId],current};});try{await this.writes;if(this.alive)this.setData({saved:"草稿已保存到本机"})}catch{if(this.alive)this.setData({saved:"草稿保存失败，请勿退出",error:"本机存储写入失败"});throw Error("草稿未能保存，请留在当前题库并重试")}
 },
 async restoreDraft(){const d=(await readLocal()).drafts?.[this.data.bankId];this.setData({text:"",reply:null,original:"",metadata:intakeMetadata(),batchId:"",editing:"",recordedAt:"",...(d?.current||{}),hasPrevious:!!d?.previous});if(this.data.reply)this.setDraft(this.data.reply,false);this.setData({tagsText:this.data.metadata.tags.join("|"),difficultyIndex:["","easy","medium","hard"].indexOf(this.data.metadata.difficulty)});},
 async rememberPrevious(){await this.persistDraft();const id=this.data.bankId;await updateLocal(d=>{if(d.drafts?.[id])d.drafts[id].previous=d.drafts[id].current});this.setData({hasPrevious:true});},
 onRestore(){void this.run(async()=>{const id=this.data.bankId;await updateLocal(d=>{const saved=d.drafts?.[id];if(saved?.previous){const current=saved.current;saved.current=saved.previous;saved.previous=current}});await this.restoreDraft()});},
 onManual(){void this.run(async()=>{await this.rememberPrevious();this.setData({text:"",original:"",editing:"",recordedAt:""});this.setDraft(emptyReply());});},
 onClear(){void this.run(async()=>{await this.rememberPrevious();this.setData({text:"",reply:null,editing:"",recordedAt:"",original:""});await this.persistDraft()});},
 async run(action:()=>Promise<void>){
  if(this.locked)return;this.locked=true;this.setData({busy:true,error:'',notice:''});
  try{await action()}catch(e){if(this.alive)this.setData({error:e instanceof Error?e.message:(e as {errMsg?:string})?.errMsg||'操作失败，请重试'})}
  finally{this.locked=false;if(this.alive){this.setData({busy:false});this.refreshAuth();}}
 },
 async refresh(){
  const banks=await listBanks(),data=await readLocal();if(!this.alive)return;
  const bankId=banks.some(b=>b.id===this.data.bankId)?this.data.bankId:banks[0].id;
  const batches=[{id:'',label:'本次新批次'},...data.batches.filter(b=>b.bankId===bankId&&data.entries.some(e=>e.batchId===b.id)).slice().reverse().map(b=>({id:b.id,label:`${localTime(b.createdAt)} · ${data.entries.filter(e=>e.batchId===b.id).length} 题`}))];
  const batchId=batches.some(b=>b.id===this.data.batchId)?this.data.batchId:'';
  const upload=data.batches.find(b=>b.id===batchId)?.upload;
  if(!this.alive||bankId!==this.data.bankId)return;
  const entries=data.entries.filter(e=>e.bankId===bankId&&e.uploadStatus!=='uploaded').map(e=>({recordedAt:displayTime(recordedTime(e.question)),editable:!data.batches.find(b=>b.id===e.batchId)?.sealedText&&!data.batches.find(b=>b.id===e.batchId)?.upload,id:e.question.question_id,stem:e.question.stem,answer:answerText(e.question),uploadStatus:e.uploadStatus,
   statusLabel:'待上传'+(data.jobs?.some(j=>j.id===e.batchId)?' · 已确认，等待回执':'')+(e.exportedAt?' · 已导出':'')+(e.sharedAt?' · 已调用转发':'')}));
  this.setData({jobLabels:(data.jobs||[]).filter(j=>j.bankId===bankId).map(j=>`${j.id.slice(0,8)} · ${{queued:"等待上传",uploading:"上传中",retry:"等待自动重试",paused:"需要登录恢复",failed:"需要处理",done:"回执已保存"}[j.status]} ${j.error}`),banks,bankId,bankIndex:banks.findIndex(b=>b.id===bankId),batches,batchId,batchIndex:batches.findIndex(b=>b.id===batchId),entries,
   ...(data.jobs?.some(j=>j.bankId===bankId)&&data.jobs.filter(j=>j.bankId===bankId).every(j=>j.status==='done')&&!entries.length?{notice:'本次已全部上传，回执已保存，可以关闭。'}:{}),uploadStarted:!!upload,receiptId:upload?.receipt?.submission_id||'',acceptedAt:upload?.receipt?localTime(upload.receipt.accepted_at):''});this.refreshAuth();
 },
 refreshAuth(){if(!this.alive)return;const access=cloud.state();this.setData({cloudConfigured:access.configured,loggedIn:access.loggedIn,
  authorizedBank:access.banks.some(b=>b.bank_id===this.data.bankId),uploadsEnabled:access.uploadsEnabled,
  uploadBlocked:access.loggedIn&&(!access.uploadsEnabled||!access.banks.some(b=>b.bank_id===this.data.bankId)),authorizedNames:access.banks.map(b=>b.name).join('、')});},
 onLogin(){void this.run(async()=>{await cloud.login();await retryUploads();void runUploadQueue().then(()=>this.refresh()).catch(e=>this.setData({error:String(e)}));if(this.alive)this.setData({notice:'开发者身份已验证，可上传获授权题库的新题。'});})},
 onLogout(){if(this.data.busy)return;cloud.logout();void pauseUploads().catch(e=>this.setData({error:String(e)}));this.refreshAuth();this.setData({notice:'已退出开发者登录，本地题目和云端回执仍保留。'});},
 onUpload(){void this.run(async()=>{
  if(this.data.reply||this.data.text)throw Error('当前题目还未保存，请先保存本题或收起草稿');
  const bankId=this.data.bankId,data=await readLocal(),batches=data.batches.filter(b=>b.bankId===bankId&&!b.upload?.receipt&&data.entries.some(e=>e.batchId===b.id)&&!data.jobs?.some(j=>j.id===b.id));
  if(!batches.length){await retryUploads();await runUploadQueue();await this.refresh();return;}
  const reviewEntries=data.entries.filter(e=>batches.some(b=>b.id===e.batchId)),count=reviewEntries.length,signature=JSON.stringify(reviewEntries.map(e=>e.question));
  if(this.data.reviewBank!==bankId||this.data.reviewSignature!==signature){this.setData({reviewBank:bankId,reviewSignature:signature,reviewRows:reviewEntries.map(e=>({id:e.question.question_id,stem:e.question.stem,options:e.question.options,answer:answerText(e.question),explanation:e.question.explanation,recordedAt:displayTime(recordedTime(e.question))})),notice:'请检查下方全部题目，完成后点击确认上传。'});return;}

  const confirmed=await new Promise<boolean>(resolve=>wx.showModal({title:'完成录入并上传',content:`已核实本题库全部 ${count} 道未提交新题？确认后统一上传，超限自动拆包，成功后直接待合并。`,confirmText:'确认上传',success:r=>resolve(r.confirm),fail:()=>resolve(false)}));
  if(!confirmed)return;await enqueueBatches(bankId,batches.map(b=>b.id));this.setData({reviewBank:"",reviewSignature:"",reviewRows:[]});await this.refresh();this.setData({notice:'整批任务已保存，正在上传。关闭后未完成的任务下次进入会恢复。'});
  await runUploadQueue();await this.refresh();
 });},
 onCancelReview(){this.setData({reviewSignature:"",reviewBank:"",reviewRows:[]})},
 onCopyPrompt(){copyPrompt()},
 onSyncReview(){void this.run(async()=>{const id=this.data.bankId;await syncBank(id);invalidateBank(id);await this.refresh();if(this.alive)this.setData({notice:'合并状态已按最新云快照核对，原上传回执保留。'});});},
 onPaste(){if(this.data.busy)return;wx.getClipboardData({success:r=>{void this.run(async()=>{await this.rememberPrevious();this.setData({text:r.data,original:r.data,reply:null,editing:'',recordedAt:'',status:''});await this.persistDraft();this.setDraft(parseDraft(r.data),false);await this.persistDraft();})},fail:()=>this.setData({error:'无法读取剪贴板，请重试粘贴按钮或选择手工录题'})})},
 setDraft(reply:ModelReply,changed=true){this.setData({reply,boolSelected:typeof reply.answer==='boolean',typeIndex:['single','multiple','true_false'].indexOf(reply.type),sourceIndex:['platform','user','unknown'].indexOf(reply.model.version_source),
  editOptions:reply.options.map(o=>({...o,correct:Array.isArray(reply.answer)&&reply.answer.includes(o.key)})),warningsText:reply.warnings.join('\n'),
  ...(changed?{status:'',existingAnswers:[],notice:'修改只保存在本机，录完后统一上传。'}:{})});void this.persistDraft().catch(()=>{});},
 onMetadata(e:WechatMiniprogram.Input){if(this.data.busy)return;const field=e.currentTarget.dataset.field,value=e.detail.value;
  if(field==='tags')this.setData({tagsText:value,metadata:{...this.data.metadata,tags:value.split('|')}});
  else if(['chapter','applicable_version','external_id'].includes(field))this.setData({metadata:{...this.data.metadata,[field]:value}});void this.persistDraft().catch(()=>{});
 },
 onDifficulty(e:WechatMiniprogram.PickerChange){const i=Number(e.detail.value);this.setData({difficultyIndex:i,metadata:{...this.data.metadata,difficulty:(['','easy','medium','hard'] as const)[i]}});void this.persistDraft().catch(()=>{});},
 onField(e:WechatMiniprogram.Input){const r=this.data.reply;if(!r||this.data.busy)return;const field=e.currentTarget.dataset.field,value=e.detail.value;
  if(field==='stem'||field==='explanation')this.setDraft({...r,[field]:value});
  else if(field==='name'||field==='version')this.setDraft({...r,model:{...r.model,[field]:value}});
  else if(field==='warnings')this.setDraft({...r,warnings:value.split('\n').filter(Boolean)});
  else if(field==='option'){const options=r.options.map((o,i)=>i===Number(e.currentTarget.dataset.index)?{...o,content:value}:o);this.setDraft({...r,options});}
 },
 onType(e:WechatMiniprogram.PickerChange){if(this.data.reply)this.setDraft(changeQuestionType(this.data.reply,(['single','multiple','true_false'] as const)[Number(e.detail.value)]));},
 onVersionSource(e:WechatMiniprogram.PickerChange){const r=this.data.reply;if(r)this.setDraft({...r,model:{...r.model,version_source:(['platform','user','unknown'] as const)[Number(e.detail.value)]}});},
 onAnswer(e:WechatMiniprogram.TouchEvent){if(this.data.reply)this.setDraft(toggleAnswer(this.data.reply,String(e.currentTarget.dataset.key)))},
 onBool(e:WechatMiniprogram.TouchEvent){if(this.data.reply)this.setDraft(toggleAnswer(this.data.reply,e.currentTarget.dataset.value==='true'))},
 onOption(e:WechatMiniprogram.TouchEvent){const r=this.data.reply;if(!r||this.data.busy)return;const i=Number(e.currentTarget.dataset.index),action=e.currentTarget.dataset.action;
  if(action==='add'){if(r.options.length<8)this.setDraft({...r,options:[...r.options,{key:'ABCDEFGH'[r.options.length],content:''}]});return;}
  const order=r.options.map((_,n)=>n);if(action==='remove')order.splice(i,1);else {const j=i+(action==='up'?-1:1);if(j<0||j>=order.length)return;[order[i],order[j]]=[order[j],order[i]];}
  this.setDraft(reorderOptions(r,order));
 },
 onBankChange(event:WechatMiniprogram.PickerChange){
  if(this.data.busy)return;const bank=this.data.banks[Number(event.detail.value)];if(!bank)return;
  void this.run(async()=>{await this.persistDraft();this.setData({reviewSignature:"",reviewBank:"",reviewRows:[],bankId:bank.id,filePath:'',fileName:''});selectBank(bank.id);await this.restoreDraft();await this.refresh();});
 },
 onCreateBank(){
  if(this.data.busy)return;
  wx.showModal({title:'新建题库',editable:true,placeholderText:'例如：HarmonyOS 高级认证',success:r=>{
   if(r.confirm)void this.run(async()=>{await this.persistDraft();const id=await createBank(r.content||'');this.setData({bankId:id,batchId:'',reply:null,status:'',filePath:'',fileName:''});await this.restoreDraft();await this.refresh()});
  }});
 },
 onBatchChange(event:WechatMiniprogram.PickerChange){
  if(this.data.busy)return;this.setData({batchId:this.data.batches[Number(event.detail.value)]?.id||'',filePath:'',fileName:''});void this.run(()=>this.refresh());
 },
 onNewBatch(){if(this.data.busy)return;this.setData({batchId:'',filePath:'',fileName:''});void this.run(()=>this.refresh())},
 onEdit(e:WechatMiniprogram.TouchEvent){void this.run(async()=>{const entry=(await readLocal()).entries.find(v=>v.bankId===this.data.bankId&&v.question.question_id===e.currentTarget.dataset.id);if(!entry)return;await this.rememberPrevious();const q=entry.question,reply=replyFromQuestion(q);this.setData({text:'',original:JSON.stringify(reply),batchId:entry.batchId,editing:q.question_id,recordedAt:displayTime(recordedTime(q)),metadata:intakeMetadata({chapter:q.chapter,tags:q.tags,difficulty:q.difficulty as ''|'easy'|'medium'|'hard',applicable_version:q.applicable_version,external_id:q.external_id})});this.setDraft(reply);this.setData({tagsText:q.tags.join('|'),difficultyIndex:['','easy','medium','hard'].indexOf(String(q.difficulty||''))});});},
 onSave(){void this.run(async()=>{
  if(!this.data.reply)throw Error('请先粘贴或手工录题');const text=editedReplyText(this.data.reply,this.data.original);parseModelReply(text);
  let batchId=this.data.batchId;
  if(this.data.editing)await editReply(this.data.bankId,this.data.editing,text,this.data.metadata);
  else{const result=await saveReply(this.data.bankId,batchId,text,this.data.metadata);if(!result.added)throw Error(result.comparison.status==='conflict'?'已有同题答案不同，请核对；现有答案已保留':'已有同题，未重复录入');batchId=result.batchId;}
  this.setData({metadata:{...this.data.metadata,external_id:''},batchId,text:'',reply:null,editing:'',recordedAt:'',status:'',filePath:'',fileName:'',notice:'本题已存本地。可继续录入，全部完成后再统一上传。'});await this.persistDraft();await this.refresh();
 })},
 onExport(){void this.run(async()=>{
  const file=await exportBatch(this.data.batchId,true);if(!this.alive)return;
  this.setData({...file,notice:'增量包已保存。点击下方按钮转发给微信好友；桌面端可直接拖入导入。'});await this.refresh();
 })},
 onShare(){
  if(this.data.busy||!this.data.filePath)return;
  const api=wx as typeof wx & ShareAPI;
  if(!api.shareFileMessage){this.setData({error:'当前微信不支持文件转发，请升级微信后在手机上使用。增量包已保留。'});return;}
  // Invoke directly from this user tap, after the separate export step.
  const batchId=this.data.batchId;
  this.locked=true;this.setData({busy:true,error:''});
  api.shareFileMessage({filePath:this.data.filePath,fileName:this.data.fileName,success:()=>{
   void updateLocal(data=>{for(const e of data.entries)if(e.batchId===batchId)e.sharedAt=new Date().toISOString()})
    .then(()=>this.refresh()).catch(()=>{if(this.alive)this.setData({error:'转发接口已返回成功，本地转发记录保存失败；可重试。'})})
    .finally(()=>{this.locked=false;if(this.alive)this.setData({busy:false,notice:'微信转发接口已返回成功，请在聊天中确认文件。分享不改变云端上传状态。'})});
  },fail:e=>{this.locked=false;if(this.alive)this.setData({busy:false,notice:/cancel/i.test(e.errMsg)?'已取消转发，文件仍保存在本机。':'',error:/cancel/i.test(e.errMsg)?'':`转发未完成，请在手机微信重试：${e.errMsg}`})}});
 },
 onImport(){
  if(this.data.busy)return;
  wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:r=>{
   const f=r.tempFiles[0];if(!f)return;
   void this.run(async()=>{
    if(!f.name.toLowerCase().endsWith('.json'))throw new Error('请选择 .qbank-delta.json 或 .qbank-upload.json 增量题库包');
    if(f.size>32*1024*1024)throw new Error('增量包超过 32 MB，请拆分后导入');
    const text=await new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:f.path,encoding:'utf8',success:x=>resolve(x.data as string),fail:reject}));
    await this.persistDraft();const result=await importDelta(text);selectBank(result.bankId);await loadBank(result.bankId);
    this.setData({bankId:result.bankId,batchId:'',reply:null,status:'',filePath:'',fileName:'',notice:`${result.name}：新增 ${result.added} 题，重复 ${result.skipped} 题，答案或 ID 不一致 ${result.conflicts} 题（保留现有题目）。`});await this.restoreDraft();await this.refresh();
   });
  },fail:e=>{if(!/cancel/i.test(e.errMsg))this.setData({error:e.errMsg})}});
 },
});
