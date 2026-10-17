import {activeBankId,listBanks,selectBank,createBank,loadBank} from '../../services/bank';
import {readLocal,updateLocal} from '../../services/intake-store';
import {compareReply,saveReply,exportBatch,importDelta} from '../../services/intake';
import {cloud} from '../../services/cloud';
import {uploadBatch} from '../../services/cloud-intake';
import {copyPrompt} from '../../services/prompt';
import {APP_VERSION} from '../../generated/client-assets';
import {answerText} from '../../core/search';
import type {ModelReply} from '../../core/intake';
type BatchRow={id:string;label:string};
type EntryRow={id:string;stem:string;answer:string;uploadStatus:string;statusLabel:string};
type ShareAPI={shareFileMessage?:(o:{filePath:string;fileName:string;success:()=>void;fail:(e:{errMsg:string})=>void})=>void};
function localTime(value:string){const d=new Date(value);if(!Number.isFinite(d.getTime()))return value;
 const two=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${two(d.getMonth()+1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;}
Page({
 data:{appVersion:APP_VERSION,banks:[] as {id:string;name:string}[],bankIndex:0,bankId:'',text:'',
  batches:[{id:'',label:'本次新批次'}] as BatchRow[],batchIndex:0,batchId:'',entries:[] as EntryRow[],
  reply:null as ModelReply|null,status:'',answer:'',existingAnswers:[] as string[],busy:false,error:'',notice:'',filePath:'',fileName:'',
  cloudConfigured:false,loggedIn:false,authorizedBank:false,uploadsEnabled:false,uploadBlocked:false,authorizedNames:'',uploadStarted:false,receiptId:'',acceptedAt:''},
 alive:true,locked:false,
 async onLoad(params:Record<string,string|undefined>){this.setData({bankId:params.bank||activeBankId()});await this.run(()=>this.refresh());},
 onShow(){this.refreshAuth()},
 onUnload(){this.alive=false},
 async run(action:()=>Promise<void>){
  if(this.locked)return;this.locked=true;this.setData({busy:true,error:'',notice:''});
  try{await action()}catch(e){if(this.alive)this.setData({error:e instanceof Error?e.message:(e as {errMsg?:string})?.errMsg||'操作失败，请重试'})}
  finally{this.locked=false;if(this.alive){this.setData({busy:false});this.refreshAuth();}}
 },
 async refresh(){
  const banks=await listBanks(),data=await readLocal();if(!this.alive)return;
  const bankId=banks.some(b=>b.id===this.data.bankId)?this.data.bankId:banks[0].id;
  const batches=[{id:'',label:'本次新批次'},...data.batches.filter(b=>b.bankId===bankId).slice().reverse().map(b=>({id:b.id,label:`${localTime(b.createdAt)} · ${data.entries.filter(e=>e.batchId===b.id).length} 题`}))];
  const batchId=batches.some(b=>b.id===this.data.batchId)?this.data.batchId:'';
  const upload=data.batches.find(b=>b.id===batchId)?.upload;
  const entries=data.entries.filter(e=>e.bankId===bankId&&e.batchId===batchId).map(e=>({id:e.question.question_id,stem:e.question.stem,answer:answerText(e.question),uploadStatus:e.uploadStatus,
   statusLabel:(e.uploadStatus==='uploaded'&&upload?.receipt?'已上传 · 待审核':e.uploadStatus==='uploaded_manual'?'历史手动标记 · 云端未确认':upload?'上传待确认，可重试':'待上传')+(e.exportedAt?' · 已导出':'')+(e.sharedAt?' · 已调用转发':'')}));
  this.setData({banks,bankId,bankIndex:banks.findIndex(b=>b.id===bankId),batches,batchId,batchIndex:batches.findIndex(b=>b.id===batchId),entries,
   uploadStarted:!!upload,receiptId:upload?.receipt?.submission_id||'',acceptedAt:upload?.receipt?localTime(upload.receipt.accepted_at):''});this.refreshAuth();
 },
 refreshAuth(){if(!this.alive)return;const access=cloud.state();this.setData({cloudConfigured:access.configured,loggedIn:access.loggedIn,
  authorizedBank:access.banks.some(b=>b.bank_id===this.data.bankId),uploadsEnabled:access.uploadsEnabled,
  uploadBlocked:access.loggedIn&&(!access.uploadsEnabled||!access.banks.some(b=>b.bank_id===this.data.bankId)),authorizedNames:access.banks.map(b=>b.name).join('、')});},
 onLogin(){void this.run(async()=>{await cloud.login();if(this.alive)this.setData({notice:'开发者身份已验证，可上传获授权题库的新题。'});})},
 onLogout(){if(this.data.busy)return;cloud.logout();this.refreshAuth();this.setData({notice:'已退出开发者登录，本地题目和云端回执仍保留。'});},
 onUpload(){const bankId=this.data.bankId,batchId=this.data.batchId;void this.run(async()=>{
  try{const result=await uploadBatch(bankId,batchId);if(this.alive)this.setData({notice:result.duplicate?'云端已保存此批次，原回执已确认。题目等待审核。':'本批次已上传并取得回执，题目等待审核。'});}
  finally{await this.refresh();}
 });},
 onCopyPrompt(){copyPrompt()},
 onInput(event:WechatMiniprogram.Input){this.setData({text:event.detail.value,reply:null,status:'',notice:''})},
 onPaste(){if(this.data.busy)return;wx.getClipboardData({success:r=>{if(this.alive)this.setData({text:r.data,reply:null,status:'',notice:''})},fail:()=>this.setData({error:'无法读取剪贴板，请长按输入框粘贴'})})},
 onBankChange(event:WechatMiniprogram.PickerChange){
  if(this.data.busy)return;const bank=this.data.banks[Number(event.detail.value)];if(!bank)return;
  this.setData({bankId:bank.id,batchId:'',reply:null,status:'',filePath:'',fileName:''});selectBank(bank.id);void this.run(()=>this.refresh());
 },
 onCreateBank(){
  if(this.data.busy)return;
  wx.showModal({title:'新建题库',editable:true,placeholderText:'例如：HarmonyOS 高级认证',success:r=>{
   if(r.confirm)void this.run(async()=>{const id=await createBank(r.content||'');this.setData({bankId:id,batchId:'',reply:null,status:'',filePath:'',fileName:''});await this.refresh()});
  }});
 },
 onBatchChange(event:WechatMiniprogram.PickerChange){
  if(this.data.busy)return;this.setData({batchId:this.data.batches[Number(event.detail.value)]?.id||'',filePath:'',fileName:''});void this.run(()=>this.refresh());
 },
 onNewBatch(){if(this.data.busy)return;this.setData({batchId:'',filePath:'',fileName:''});void this.run(()=>this.refresh())},
 onParse(){void this.run(async()=>{
  const result=await compareReply(this.data.bankId,this.data.text);if(!this.alive)return;
  this.setData({reply:result.reply,status:result.status,answer:Array.isArray(result.reply.answer)?result.reply.answer.join(' · '):result.reply.answer?'正确':'错误',
   existingAnswers:result.matches.map(q=>`${answerText(q)}${q.options.length?'（'+q.options.map(o=>o.key+'. '+o.content).join('；')+'）':''}`),notice:''});
 })},
 onSave(){void this.run(async()=>{
  const result=await saveReply(this.data.bankId,this.data.batchId,this.data.text);if(!this.alive)return;
  if(result.added)this.setData({batchId:result.batchId,text:'',reply:null,status:'',filePath:'',fileName:'',notice:(this.data.batchId&&result.batchId!==this.data.batchId?'原批次已导出、提交或达到 100 题，已开启新批次。':'')+'已保存新题，可继续粘贴下一道题。上传状态：待上传。'});
  else this.setData({reply:null,status:'',notice:'题库已有此题，没有重复录入。请重新比对查看。'});
  await this.refresh();
 })},
 onExport(){void this.run(async()=>{
  const file=await exportBatch(this.data.batchId);if(!this.alive)return;
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
    if(!f.name.toLowerCase().endsWith('.json'))throw new Error('请选择 .qbank-delta.json 增量题库包');
    if(f.size>32*1024*1024)throw new Error('增量包超过 32 MB，请拆分后导入');
    const text=await new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:f.path,encoding:'utf8',success:x=>resolve(x.data as string),fail:reject}));
    const result=await importDelta(text);selectBank(result.bankId);await loadBank(result.bankId);
    this.setData({bankId:result.bankId,batchId:'',reply:null,status:'',filePath:'',fileName:'',notice:`${result.name}：新增 ${result.added} 题，重复 ${result.skipped} 题，答案或 ID 不一致 ${result.conflicts} 题（保留现有题目）。`});await this.refresh();
   });
  },fail:e=>{if(!/cancel/i.test(e.errMsg))this.setData({error:e.errMsg})}});
 },
});
