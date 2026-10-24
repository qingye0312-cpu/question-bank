import {themePageData,showPageTheme,hidePageTheme} from '../../services/appearance';
import {pauseUploads} from '../../services/cloud-intake';
import {activeBankId,listBanks,selectBank,createBank,type BankSummary} from '../../services/bank';
import {IntakeController} from '../../services/intake-controller';
import {changeQuestionType,toggleAnswer,reorderOptions,type ModelReply} from '../../core/intake';
import {cloud} from '../../services/cloud';
import {applicationFields} from '../../services/maintainer-application';
import {refreshCatalog} from '../../services/sync';
import {copyPrompt} from '../../services/prompt';
import {importDelta} from '../../services/intake';
let controller:IntakeController|undefined,alive=false,poll:ReturnType<typeof setInterval>|undefined,previousType:ModelReply|null=null;
Page({
  data:{...themePageData(),currentId:'',banks:[] as BankSummary[],bankIndex:0,tab:'edit',busy:false,ready:false,reply:null as ModelReply|null,locked:false,raw:'',records:[] as any[],visibleRecords:[] as any[],jobs:[] as any[],pendingCount:0,issues:[] as any[],sourceIssues:[] as any[],saved:'',error:'',notice:'',more:false,tools:false,canUndo:false,canUndoType:false,recordedAt:'',metadata:{} as any,editOptions:[] as any[],boolSelected:false,typeIndex:0,sourceIndex:2,warningsText:'',tagsText:'',difficultyIndex:0,filePath:'',fileName:'',query:'',loggedIn:false,maintainerPhone:'',maintainerRealName:'',maintainerNickname:'',maintainerIdentity:'',maintainerApplication:'',applying:false,applicationMessage:'',applicationError:false,
  types:['单选','多选','判断'],versionSources:['平台提供','用户提供','未知'],difficulties:['未设置','简单','中等','困难']},
 onLoad(){alive=true;previousType=null;controller=new IntakeController(view=>{if(!alive)return;const changed=view.currentId!==this.data.currentId||view.raw!==this.data.raw;if(changed)previousType=null;this.setData({...view,...(changed?{canUndoType:false}:{}),visibleRecords:view.records.filter(r=>!this.data.query||r.stem.includes(this.data.query))})});void this.run(async()=>{const banks=await listBanks(),bank=activeBankId();this.setData({banks,bankIndex:Math.max(0,banks.findIndex(b=>b.id===bank))});await controller!.open(bank);this.setData({ready:true});});},
 onShow(){showPageTheme(this);alive=true;this.setData({loggedIn:cloud.state().loggedIn});poll=setInterval(()=>void controller?.refreshJobs().catch(()=>{}),3000)},
 onHide(){hidePageTheme(this);if(poll)clearInterval(poll);void controller?.flush().catch(()=>{})},
 onUnload(){hidePageTheme(this);alive=false;if(poll)clearInterval(poll);controller?.dispose();controller=undefined},
 async run(fn:()=>Promise<void>){if(this.data.busy||this.data.applying)return;this.setData({busy:true,error:'',notice:''});try{await fn()}catch(e){if(alive&&controller){controller.error=e instanceof Error?e.message:(e as any)?.errMsg||String(e);controller.render()}}finally{if(alive)this.setData({busy:false,loggedIn:cloud.state().loggedIn})}},
 onTab(e:WechatMiniprogram.TouchEvent){void this.run(async()=>{await controller!.flush();this.setData({tab:e.currentTarget.dataset.tab})})},
 onBankChange(e:WechatMiniprogram.PickerChange){const index=Number(e.detail.value),bank=this.data.banks[index];void this.run(async()=>{await controller!.open(bank.id);selectBank(bank.id);this.setData({bankIndex:index,filePath:'',query:''})})},
 onSearch(e:WechatMiniprogram.Input){const query=e.detail.value;this.setData({query,visibleRecords:this.data.records.filter(r=>!query||r.stem.includes(query))})},
 onCopyPrompt(){copyPrompt()},
 onPaste(){if(this.data.locked||this.data.busy)return;const record=controller?.current;wx.getClipboardData({success:r=>{if(alive&&!this.data.busy&&controller?.current===record)controller?.paste(r.data)},fail:()=>{if(alive)this.setData({error:'无法读取剪贴板，请重试'})}})},
 onManual(){if(this.data.locked||this.data.busy)return;previousType=null;this.setData({canUndoType:false});controller?.manual()},
 onAcknowledge(){if(this.data.locked||this.data.busy)return;controller?.change({sourceIssues:[]})},
 onCopyRaw(){wx.setClipboardData({data:this.data.raw})},
 onBlur(){void controller?.flush().catch(()=>{})},
 onNext(){void this.run(async()=>{await controller!.next();previousType=null;this.setData({tab:'edit',canUndoType:false})})},
 onEdit(e:WechatMiniprogram.TouchEvent){void this.run(async()=>{await controller!.select(e.currentTarget.dataset.id);previousType=null;this.setData({tab:'edit',canUndoType:false})})},
 onRemove(e:WechatMiniprogram.TouchEvent){void this.run(()=>controller!.remove(e.currentTarget.dataset.id))},
 onUndo(){void this.run(()=>controller!.remove(controller!.undoId,false))},
 onMore(){this.setData({more:!this.data.more})},onTools(){this.setData({tools:!this.data.tools})},
 onField(e:WechatMiniprogram.Input){const r=controller?.current?.reply;if(!r||this.data.locked||this.data.busy)return;const key=e.currentTarget.dataset.field,v=e.detail.value;
  if(key==='stem'||key==='explanation')controller!.change({reply:{...r,[key]:v}});
  else if(key==='name'||key==='version')controller!.change({reply:{...r,model:{...r.model,[key]:v}}});
  else if(key==='warnings')controller!.change({reply:{...r,warnings:v.split('\n').filter(Boolean)}});
  else if(key==='option')controller!.change({reply:{...r,options:r.options.map((o,i)=>i===Number(e.currentTarget.dataset.index)?{...o,content:v}:o)}});
 },
 onMetadata(e:WechatMiniprogram.Input){const r=controller?.current;if(!r||this.data.locked||this.data.busy)return;const key=e.currentTarget.dataset.field;controller!.change({metadata:{...r.metadata,[key]:key==='tags'?e.detail.value.split('|'):e.detail.value}})},
 onDifficulty(e:WechatMiniprogram.PickerChange){if(this.data.locked||this.data.busy)return;const r=controller!.current!;controller!.change({metadata:{...r.metadata,difficulty:(['','easy','medium','hard'] as const)[Number(e.detail.value)]}})},
 onType(e:WechatMiniprogram.PickerChange){if(this.data.locked||this.data.busy)return;const r=controller?.current?.reply;if(r){previousType=r;controller!.change({reply:changeQuestionType(r,(['single','multiple','true_false'] as const)[Number(e.detail.value)])});this.setData({canUndoType:true})}},
 onUndoType(){if(this.data.locked||this.data.busy)return;if(previousType){controller?.change({reply:previousType});previousType=null;this.setData({canUndoType:false})}},
 onVersionSource(e:WechatMiniprogram.PickerChange){if(this.data.locked||this.data.busy)return;const r=controller!.current!.reply!;controller!.change({reply:{...r,model:{...r.model,version_source:(['platform','user','unknown'] as const)[Number(e.detail.value)]}}})},
 onAnswer(e:WechatMiniprogram.TouchEvent){if(this.data.locked||this.data.busy)return;const r=controller?.current?.reply;if(r)controller!.change({reply:toggleAnswer(r,String(e.currentTarget.dataset.key))})},
 onBool(e:WechatMiniprogram.TouchEvent){if(this.data.locked||this.data.busy)return;const r=controller?.current?.reply;if(r)controller!.change({reply:toggleAnswer(r,e.currentTarget.dataset.value==='true')})},
 onAddOption(){if(this.data.locked||this.data.busy)return;const r=controller?.current?.reply;if(r&&r.options.length<8)controller!.change({reply:{...r,options:[...r.options,{key:String.fromCharCode(65+r.options.length),content:''}]}})},
 onOptionMenu(e:WechatMiniprogram.TouchEvent){if(this.data.locked||this.data.busy)return;const r=controller?.current?.reply;if(!r)return;const index=Number(e.currentTarget.dataset.index),actions=['上移','下移','删除'];wx.showActionSheet({itemList:actions,success:result=>{const current=controller?.current?.reply;if(!alive||this.data.locked||this.data.busy||current!==r)return;const order=r.options.map((_,i)=>i),action=result.tapIndex;if(action===2){if(r.options.length<=2&&r.type!=='true_false'){this.setData({error:'选择题至少保留两个选项'});return;}order.splice(index,1);}else{const to=index+(action===0?-1:1);if(to<0||to>=order.length)return;[order[index],order[to]]=[order[to],order[index]];}controller!.change({reply:reorderOptions(r,order)})}})},
 onUpload(){
  if(!cloud.state().loggedIn){this.setData({tab:'uploads',error:'上传前请在下方填写手机号、真实姓名和身份说明，再提交维护者申请'});return;}
  void this.run(async()=>{await controller!.upload();this.setData({tab:'uploads',notice:'全部题目已统一压缩编码，任务已保存。可以继续录题。'})})
 },
 onMaintainerPhone(e:WechatMiniprogram.Input){this.setData({maintainerPhone:e.detail.value})},
 onMaintainerRealName(e:WechatMiniprogram.Input){this.setData({maintainerRealName:e.detail.value})},
 onMaintainerNickname(e:WechatMiniprogram.Input){this.setData({maintainerNickname:e.detail.value})},
 onMaintainerIdentity(e:WechatMiniprogram.Input){this.setData({maintainerIdentity:e.detail.value})},
 async onApplyMaintainer(){
  if(this.data.busy||this.data.applying)return;
  this.setData({applying:true,applicationError:false,applicationMessage:'正在检查申请信息…'});
  try{
    const form={phone:this.data.maintainerPhone,realName:this.data.maintainerRealName,nickname:this.data.maintainerNickname,identity:this.data.maintainerIdentity};
    applicationFields(form);
    if(!cloud.state().configured)throw Error('尚未配置云端 HTTPS 域名，暂时无法提交申请，请联系管理员');
    const bank=this.data.banks[this.data.bankIndex];if(!bank)throw Error('请先选择题库');
    const catalog=await refreshCatalog();
    if(!catalog.some(b=>b.bank_id===bank.id))throw Error('当前是私人本地题库，请先选择要申请维护的云端题库');
    if(!alive)return;
    this.setData({applicationMessage:'正在登录微信并提交申请…'});
    const application=await cloud.applyMaintainer(bank.id,form);
    if(alive)this.setData({maintainerApplication:application.status,applicationMessage:application.status==='pending'?'申请已提交，等待桌面管理员核实。可切换其他云端题库追加申请。':'已获得当前题库的维护权限，可以上传题目。'});
  }catch(error){
    if(alive){const message=error instanceof Error?error.message:'申请未完成，请重试';this.setData({applicationError:true,applicationMessage:message});wx.showToast({title:message,icon:'none',duration:3000});}
  }finally{if(alive)this.setData({applying:false,loggedIn:cloud.state().loggedIn});}
 },
 onRetry(){
  if(!cloud.state().loggedIn){this.setData({tab:'uploads',error:'恢复上传前请在下方提交申请或刷新微信登录'});return;}
  void this.run(()=>controller!.retry())
 },
 onSync(){void this.run(()=>controller!.sync())},
 onLogout(){cloud.logout();void pauseUploads().catch(e=>{controller!.error=String(e);controller!.render()});this.setData({loggedIn:false})},
 onExport(){void this.run(async()=>{const file=await controller!.export();this.setData({...file,notice:'已导出，题目仍可修改；未触发上传'})})},
 onShare(){if(!this.data.filePath)return;(wx as WechatMiniprogram.Wx & {shareFileMessage:(options:{filePath:string;fileName:string;fail:(e:{errMsg:string})=>void})=>void}).shareFileMessage({filePath:this.data.filePath,fileName:this.data.fileName,fail:e=>this.setData({error:e.errMsg})})},
 onCreateBank(){wx.showModal({title:'新建私人本地题库',editable:true,placeholderText:'题库名称',success:r=>{if(r.confirm)void this.run(async()=>{const id=await createBank(r.content||''),banks=await listBanks();await controller!.open(id);this.setData({banks,bankIndex:banks.findIndex(b=>b.id===id),tab:'edit'})})}})},
 onImport(){wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:r=>{void this.run(async()=>{const path=r.tempFiles[0].path;const text=await new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:path,encoding:'utf8',success:v=>resolve(v.data as string),fail:reject}));const result=await importDelta(text);const banks=await listBanks();await controller!.open(result.bankId);this.setData({banks,bankIndex:banks.findIndex(b=>b.id===result.bankId),tab:'records',notice:`已导入 ${result.added} 题，未上传`})})}})},
});
