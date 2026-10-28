import {themePageData,showPageTheme,hidePageTheme} from '../../services/appearance';
import {pauseUploads} from '../../services/cloud-intake';
import {activeBankId,listBanks,selectBank,createBank,type BankSummary} from '../../services/bank';
import {IntakeController} from '../../services/intake-controller';
import {changeQuestionType,toggleAnswer,reorderOptions,type ModelReply} from '../../core/intake';
import {cloud} from '../../services/cloud';
import {maintainerPasswordRules,passwordMeetsPolicy,registrationFields,type PasswordRule} from '../../services/maintainer-application';
import {refreshCatalog} from '../../services/sync';
import {copyPrompt} from '../../services/prompt';
import {importDelta} from '../../services/intake';
type MaintainerBankChoice={bank_id:string;name:string;checked:boolean};
let controller:IntakeController|undefined,alive=false,poll:ReturnType<typeof setInterval>|undefined,prepareTimer:ReturnType<typeof setTimeout>|undefined,exportGeneration=0,exportSignature='',previousType:ModelReply|null=null;
Page({
  data:{...themePageData(),currentId:'',banks:[] as BankSummary[],bankIndex:0,tab:'edit',busy:false,ready:false,reply:null as ModelReply|null,locked:false,raw:'',records:[] as any[],visibleRecords:[] as any[],jobs:[] as any[],pendingCount:0,issues:[] as any[],sourceIssues:[] as any[],saved:'',error:'',notice:'',more:false,tools:false,canUndoType:false,recordedAt:'',metadata:{} as any,editOptions:[] as any[],boolSelected:false,typeIndex:0,sourceIndex:2,warningsText:'',tagsText:'',difficultyIndex:0,filePath:'',fileName:'',exportPrepared:false,query:'',loggedIn:false,hasExportPermission:false,pendingExportPermission:false,authMode:'login',maintainerPassword:'',maintainerPasswordRules:[] as PasswordRule[],maintainerPasswordConfirm:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false,maintainerResetToken:'',maintainerAuthType:'',maintainerAccountStatus:'',maintainerPhone:'',maintainerPhoneDisplay:'',maintainerRealName:'',maintainerNickname:'',maintainerIdentity:'',applyExportPermission:false,maintainerBanks:[] as MaintainerBankChoice[],maintainerBankIds:[] as string[],maintainerBanksLoading:false,maintainerBanksError:'',maintainerApplication:'',applying:false,applicationMessage:'',applicationError:false,
  types:['单选','多选','判断'],versionSources:['平台提供','用户提供','未知'],difficulties:['未设置','简单','中等','困难']},
 onLoad(){alive=true;previousType=null;exportSignature='';controller=new IntakeController(view=>{if(!alive)return;const changed=view.currentId!==this.data.currentId||view.raw!==this.data.raw;const signature=[view.pendingCount,...view.records.map(r=>`${r.id}:${r.revision}:${r.status}`)].join('|');if(signature!==exportSignature){exportSignature=signature;this.queueExportPreparation(signature,view.pendingCount)}if(changed)previousType=null;this.setData({...view,...(changed?{canUndoType:false}:{}),visibleRecords:view.records.filter(r=>!this.data.query||r.stem.includes(this.data.query))})});void this.run(async()=>{const banks=await listBanks(),bank=activeBankId();this.setData({banks,bankIndex:Math.max(0,banks.findIndex(b=>b.id===bank))});await controller!.open(bank);this.setData({ready:true});});},
 onShow(){showPageTheme(this);alive=true;void cloud.restoreSession().catch(()=>{}).finally(()=>{if(alive){const access=cloud.state();this.setData({loggedIn:access.loggedIn,hasExportPermission:access.permissions.includes('export'),pendingExportPermission:access.pendingPermissions.includes('export'),maintainerPhoneDisplay:access.phone||'',maintainerAuthType:access.authType||'',maintainerAccountStatus:access.status||''})}});poll=setInterval(()=>void controller?.refreshJobs().catch(()=>{}),3000)},
 onHide(){hidePageTheme(this);if(poll)clearInterval(poll);void controller?.flush().catch(()=>{})},
 onUnload(){hidePageTheme(this);alive=false;exportGeneration++;if(prepareTimer)clearTimeout(prepareTimer);prepareTimer=undefined;if(poll)clearInterval(poll);controller?.dispose();controller=undefined},
 async run(fn:()=>Promise<void>){if(this.data.busy||this.data.applying)return;this.setData({busy:true,error:'',notice:''});try{await fn()}catch(e){if(alive&&controller){controller.error=e instanceof Error?e.message:(e as any)?.errMsg||String(e);controller.render()}}finally{if(alive){const access=cloud.state();this.setData({busy:false,loggedIn:access.loggedIn,hasExportPermission:access.permissions.includes('export'),pendingExportPermission:access.pendingPermissions.includes('export')})}}},
 onTab(e:WechatMiniprogram.TouchEvent){void this.run(async()=>{await controller!.flush();this.setData({tab:e.currentTarget.dataset.tab})})},
 onBankChange(e:WechatMiniprogram.PickerChange){const index=Number(e.detail.value),bank=this.data.banks[index];void this.run(async()=>{await controller!.open(bank.id);selectBank(bank.id);this.setData({bankIndex:index,filePath:'',fileName:'',exportPrepared:false,query:''})})},
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
 onMore(){this.setData({more:!this.data.more})},onTools(){const tools=!this.data.tools;this.setData({tools});if(tools)void this.prepareExportFile(exportSignature)},
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
  if(!cloud.state().loggedIn){this.setData({tab:'uploads',error:'上传前请先注册或登录维护者账号；申请需经桌面管理员审批'});return;}
  void this.run(async()=>{await controller!.upload();this.setData({tab:'uploads',notice:'全部题目已统一压缩编码，任务已保存。可以继续录题。'})})
 },
 onMaintainerPhone(e:WechatMiniprogram.Input){this.setData({maintainerPhone:e.detail.value})},
 onMaintainerRealName(e:WechatMiniprogram.Input){this.setData({maintainerRealName:e.detail.value})},
 onMaintainerNickname(e:WechatMiniprogram.Input){this.setData({maintainerNickname:e.detail.value})},
 onMaintainerIdentity(e:WechatMiniprogram.Input){this.setData({maintainerIdentity:e.detail.value})},
 onMaintainerPassword(e:WechatMiniprogram.Input){const password=e.detail.value;this.setData({maintainerPassword:password,maintainerPasswordRules:maintainerPasswordRules(password),maintainerPasswordValid:passwordMeetsPolicy(password),maintainerPasswordsMatch:password===this.data.maintainerPasswordConfirm})},
 onMaintainerPasswordConfirm(e:WechatMiniprogram.Input){const confirm=e.detail.value;this.setData({maintainerPasswordConfirm:confirm,maintainerPasswordsMatch:confirm===this.data.maintainerPassword})},
 onMaintainerResetToken(e:WechatMiniprogram.Input){this.setData({maintainerResetToken:e.detail.value})},
 onAuthMode(e:WechatMiniprogram.TouchEvent){const mode=e.currentTarget.dataset.mode;this.setData({authMode:mode,maintainerPassword:'',maintainerPasswordRules:[],maintainerPasswordConfirm:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false,maintainerResetToken:'',applyExportPermission:false,applicationMessage:'',applicationError:false});if(mode==='register')void this.loadMaintainerBanks()},
 onToggleExportPermission(e:WechatMiniprogram.CheckboxGroupChange){this.setData({applyExportPermission:e.detail.value.includes('export')})},
 async loadMaintainerBanks(){
  if(this.data.maintainerBanksLoading)return;
  this.setData({maintainerBanksLoading:true,maintainerBanksError:''});
  try{
   if(!cloud.state().configured)throw Error('尚未配置云端 HTTPS 地址，请联系管理员');
   const catalog=await refreshCatalog(true);
   if(!alive||this.data.authMode!=='register')return;
   const available=new Set(catalog.map(bank=>bank.bank_id));
   const selected=this.data.maintainerBankIds.filter(id=>available.has(id));
   const choices:MaintainerBankChoice[]=catalog.map(bank=>({bank_id:bank.bank_id,name:bank.name,checked:selected.includes(bank.bank_id)}));
   this.setData({maintainerBanks:choices,maintainerBankIds:selected,...(!choices.length?{maintainerBanksError:'暂无可申请维护的云端题库。'}:{})});
  }catch(error){
   if(alive&&this.data.authMode==='register')this.setData({maintainerBanks:[],maintainerBankIds:[],maintainerBanksError:error instanceof Error?`读取云端题库失败：${error.message}`:'读取云端题库失败，请重试'});
  }finally{if(alive)this.setData({maintainerBanksLoading:false})}
 },
 onRefreshMaintainerBanks(){void this.loadMaintainerBanks()},
 onMaintainerBanksChange(e:WechatMiniprogram.CheckboxGroupChange){const selected=e.detail.value;this.setData({maintainerBankIds:selected,maintainerBanks:this.data.maintainerBanks.map(bank=>({...bank,checked:selected.includes(bank.bank_id)}))})},
 onForgotMaintainerPassword(){
  wx.showModal({title:'忘记密码',content:'需联系管理员重新设置维护者状态并获取一次性重置码。管理员重置后会清除现有题库维护权限和 Word 导出权限；设置新密码后还需管理员重新授权。确认后进入密码重置页面。',confirmText:'确认重置状态',cancelText:'取消',success:result=>{
    if(result.confirm)this.setData({authMode:'reset',maintainerPassword:'',maintainerPasswordConfirm:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false,maintainerResetToken:'',applicationError:false,applicationMessage:'请联系管理员获取一次性重置码。'});
  }});
 },
 async onRegisterMaintainer(){
  if(this.data.busy||this.data.applying)return;
  this.setData({applying:true,applicationError:false,applicationMessage:'正在检查申请信息…'});
  try{
    const form={password:this.data.maintainerPassword,passwordConfirm:this.data.maintainerPasswordConfirm,
      phone:this.data.maintainerPhone,realName:this.data.maintainerRealName,nickname:this.data.maintainerNickname,identity:this.data.maintainerIdentity};
    registrationFields(form);
    if(!cloud.state().configured)throw Error('尚未配置云端 HTTPS 域名，暂时无法提交申请，请联系管理员');
    const catalog=await refreshCatalog();
    let bankIds=this.data.maintainerBankIds;
    if(!bankIds.length&&!this.data.applyExportPermission){const currentBank=this.data.banks[this.data.bankIndex];if(currentBank&&catalog.some(b=>b.bank_id===currentBank.id))bankIds=[currentBank.id];}
    if(!bankIds.length&&!this.data.applyExportPermission)throw Error('至少申请一个题库维护权限或 Word 导出权限');
    if(bankIds.some(id=>!catalog.some(bank=>bank.bank_id===id)))throw Error('云端题库目录已更新，请重新获取并选择题库');
    if(!alive)return;
    this.setData({applicationMessage:'正在创建账号并提交申请…',maintainerPassword:'',maintainerPasswordConfirm:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false});
    const permissions=this.data.applyExportPermission?['export']:[];
    const application=await cloud.registerMaintainer(bankIds,form,permissions);
    const requestedBanks=bankIds.map(id=>catalog.find(bank=>bank.bank_id===id)?.name).filter((name):name is string=>Boolean(name));
    if(alive)this.setData({authMode:'login',maintainerApplication:application.status,applyExportPermission:false,applicationMessage:`手机号已登记，申请权限：${[...requestedBanks,...(permissions.includes('export')?['导出题库']:[])].join('、')}。等待桌面管理员核实，请使用手机号和密码登录查看状态。`});
  }catch(error){
    if(alive){const message=error instanceof Error?error.message:'申请未完成，请重试';this.setData({applicationError:true,applicationMessage:message});wx.showToast({title:message,icon:'none',duration:3000});}
  }finally{if(alive)this.setData({applying:false,loggedIn:cloud.state().loggedIn,maintainerPassword:'',maintainerPasswordConfirm:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false});}
 },
 async onLoginMaintainer(){
  if(this.data.busy||this.data.applying)return;
  const phone=this.data.maintainerPhone,password=this.data.maintainerPassword;
  this.setData({applying:true,applicationError:false,applicationMessage:'正在登录…',maintainerPassword:''});
  try{
    if(!cloud.state().configured)throw Error('尚未配置云端 HTTPS 地址，请联系管理员');
    const access=await cloud.loginPassword(phone,password);
    const message=access.status==='approved'?`登录成功，已授权：${access.banks.map(bank=>bank.name).join('、')||'暂无题库'}`:access.status==='rejected'?'登录成功，上次申请未通过；可重新申请当前题库。':'登录成功，维护申请仍待桌面管理员审批。';
    if(alive)this.setData({maintainerPhoneDisplay:access.phone||'',maintainerAccountStatus:access.status||'pending',maintainerAuthType:access.authType||'password',hasExportPermission:access.permissions.includes('export'),pendingExportPermission:access.pendingPermissions.includes('export'),applicationMessage:message});
  }catch(error){
    if(alive){const message=error instanceof Error?error.message:'登录失败，请检查账号密码后重试';this.setData({applicationError:true,applicationMessage:message});wx.showToast({title:message,icon:'none',duration:3000});}
  }finally{if(alive)this.setData({applying:false,loggedIn:cloud.state().loggedIn,maintainerPassword:''});}
 },
 async onResetMaintainerPassword(){
  if(this.data.busy||this.data.applying)return;
  const phone=this.data.maintainerPhone,resetToken=this.data.maintainerResetToken,password=this.data.maintainerPassword,passwordConfirm=this.data.maintainerPasswordConfirm;
  this.setData({applying:true,applicationError:false,applicationMessage:'正在重置密码…',maintainerPassword:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false});
  try{
    if(!cloud.state().configured)throw Error('尚未配置云端 HTTPS 地址，请联系管理员');
    await cloud.resetMaintainerPassword(phone,resetToken,password,passwordConfirm);
    if(alive)this.setData({authMode:'login',maintainerPasswordConfirm:'',maintainerPasswordRules:[],maintainerResetToken:'',maintainerAccountStatus:'pending',hasExportPermission:false,pendingExportPermission:false,applicationMessage:'密码已重置。维护权限已清除，请使用新密码登录并等待管理员重新授权。'});
  }catch(error){
    if(alive){const message=error instanceof Error?error.message:'密码重置失败，请联系管理员';this.setData({applicationError:true,applicationMessage:message});wx.showToast({title:message,icon:'none',duration:3000});}
  }finally{if(alive)this.setData({applying:false,loggedIn:cloud.state().loggedIn,maintainerPassword:'',maintainerPasswordConfirm:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false});}
 },
 async onRequestCurrentBank(){
  if(this.data.busy||this.data.applying)return;
  const bank=this.data.banks[this.data.bankIndex];if(!bank)return;
  this.setData({applying:true,applicationError:false,applicationMessage:'正在提交题库申请…'});
  try{
    const catalog=await refreshCatalog();if(!catalog.some(b=>b.bank_id===bank.id))throw Error('当前是私人本地题库，请先选择云端题库');
    const application=await cloud.applyMaintainer(bank.id);
    if(alive)this.setData({maintainerApplication:application.status,maintainerAccountStatus:application.status==='pending'&&this.data.maintainerAccountStatus==='rejected'?'pending':this.data.maintainerAccountStatus,applicationMessage:application.status==='pending'?'申请已提交，等待桌面管理员核实。':'已获得当前题库的维护权限，可以上传题目。'});
  }catch(error){if(alive){const message=error instanceof Error?error.message:'申请未完成，请重试';this.setData({applicationError:true,applicationMessage:message});wx.showToast({title:message,icon:'none',duration:3000});}}
  finally{if(alive)this.setData({applying:false})}
 },
 async onRequestExportPermission(){
  if(this.data.busy||this.data.applying)return;
  this.setData({applying:true,applicationError:false,applicationMessage:'正在提交 Word 导出权限申请…'});
  try{const application=await cloud.applyPermissions(['export']);const access=cloud.state();if(alive)this.setData({pendingExportPermission:access.pendingPermissions.includes('export'),hasExportPermission:access.permissions.includes('export'),applicationMessage:application.status==='pending'?'Word 导出权限申请已提交，等待桌面最高权限审批。':'已获得 Word 导出权限。'});}
  catch(error){if(alive){const message=error instanceof Error?error.message:'申请未完成，请重试';this.setData({applicationError:true,applicationMessage:message});wx.showToast({title:message,icon:'none',duration:3000});}}
  finally{if(alive)this.setData({applying:false})}
 },
 onRetry(){
  if(!cloud.state().loggedIn){this.setData({tab:'uploads',error:'恢复上传前请先登录维护者账号'});return;}
  void this.run(()=>controller!.retry())
 },
 onSync(){void this.run(()=>controller!.sync())},
 onLogout(){void cloud.logout();void pauseUploads().catch(e=>{controller!.error=String(e);controller!.render()});this.setData({loggedIn:false,hasExportPermission:false,pendingExportPermission:false,maintainerPhone:'',maintainerPhoneDisplay:'',maintainerPassword:'',maintainerPasswordConfirm:'',maintainerPasswordValid:false,maintainerPasswordsMatch:false,maintainerResetToken:'',maintainerAccountStatus:'',maintainerAuthType:'',applicationMessage:'已退出登录'})},
 queueExportPreparation(signature:string,pendingCount=this.data.pendingCount){
  if(prepareTimer)clearTimeout(prepareTimer);
  exportGeneration++;
  if(!pendingCount){this.setData({filePath:'',fileName:'',exportPrepared:false});return;}
  this.setData({exportPrepared:false});
  prepareTimer=setTimeout(()=>{prepareTimer=undefined;void this.prepareExportFile(signature)},280);
 },
 async prepareExportFile(signature:string){
  if(!alive||!controller||!this.data.pendingCount)return;
  if(prepareTimer)clearTimeout(prepareTimer);prepareTimer=undefined;
  const generation=++exportGeneration;
  try{
   const file=await controller.export();
   if(!alive||generation!==exportGeneration||signature!==exportSignature)return;
   this.setData({...file,exportPrepared:true});
  }catch{/* The button will retry preparation after the draft becomes valid. */}
 },
 shareExportFile(filePath:string,fileName:string){
  const wxApi=wx as WechatMiniprogram.Wx & {shareFileMessage?: (options:{filePath:string;fileName:string;success?:()=>void;fail:(e:{errMsg:string})=>void})=>void};
  if(typeof wxApi.shareFileMessage!=='function'){this.setData({notice:'当前微信版本不支持直接分享文件，请升级微信后重试'});return;}
  wxApi.shareFileMessage({filePath,fileName,
   success:()=>this.setData({notice:'已打开聊天分享面板，选择联系人即可发送 JSON'}),
   fail:e=>this.setData({error:e.errMsg||'打开聊天分享失败，请重试'})});
 },
 onExport(){
  if(this.data.busy||this.data.applying)return;
  if(!this.data.exportPrepared||!this.data.filePath){this.setData({notice:'正在准备导出文件，请稍后再点一次“导出并打开聊天发送”'});void this.prepareExportFile(exportSignature);return;}
  this.setData({error:'',notice:'正在打开聊天分享面板…'});
  // Keep this call directly in the tap handler. WeChat rejects calls made
  // after an awaited export because the user gesture has already ended.
  this.shareExportFile(this.data.filePath,this.data.fileName);
 },
 onCreateBank(){wx.showModal({title:'新建私人本地题库',editable:true,placeholderText:'题库名称',success:r=>{if(r.confirm)void this.run(async()=>{const id=await createBank(r.content||''),banks=await listBanks();await controller!.open(id);this.setData({banks,bankIndex:banks.findIndex(b=>b.id===id),tab:'edit'})})}})},
 onImport(){wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:r=>{void this.run(async()=>{const path=r.tempFiles[0].path;const text=await new Promise<string>((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:path,encoding:'utf8',success:v=>resolve(v.data as string),fail:reject}));const result=await importDelta(text);const banks=await listBanks();await controller!.open(result.bankId);this.setData({banks,bankIndex:banks.findIndex(b=>b.id===result.bankId),tab:'records',notice:`已导入 ${result.added} 题，未上传`})})}})},
});
