import {themePageData,showPageTheme,hidePageTheme} from '../../services/appearance';
import {activeBankId,loadBank} from '../../services/bank';
import {exportBankJson,importSharedBankJson} from '../../services/share';

type FileShareApi=WechatMiniprogram.Wx&{shareFileMessage?:(options:{filePath:string;fileName:string;success?:()=>void;fail?:(error:{errMsg:string})=>void})=>void};
function readFile(path:string):Promise<string>{return new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:path,encoding:'utf8',success:r=>resolve(r.data as string),fail:reject}))}

Page({
 data:{...themePageData(),bankId:'',bankName:'正在打开题库',questionCount:0,ready:false,jsonExpanded:false,busy:false,error:'',notice:''},
 onLoad(options:Record<string,string|undefined>={}){const id=options.bank||activeBankId();this.setData({bankId:id});void loadBank(id).then(({bank,manifest})=>this.setData({bankName:manifest.name,questionCount:bank.count,ready:true})).catch(e=>this.setData({error:e instanceof Error?e.message:'题库读取失败'}));},
 onShow(){showPageTheme(this)},
 onUnload(){hidePageTheme(this)},
 onShareAppMessage(){return {title:'知屿题库 · 分享主页',path:'/pages/index/index'}},
 onShareTimeline(){return {title:'知屿题库 · 分享主页',query:''}},
 onToggleJson(){this.setData({jsonExpanded:!this.data.jsonExpanded,error:'',notice:''})},
 onShareJson(){return this.run(async()=>{
  const file=await exportBankJson(this.data.bankId||activeBankId());
  const share=(wx as FileShareApi).shareFileMessage;
  if(!share)throw new Error('当前微信版本不支持转发文件，请升级微信后重试');
  await new Promise<void>((resolve,reject)=>share.call(wx,{filePath:file.filePath,fileName:file.fileName,success:resolve,fail:e=>reject(new Error(e.errMsg||'文件分享失败'))}));
  this.setData({notice:`已分享 ${file.questionCount} 道题的 JSON 文件；接收方可在题库中选中文件后自动导入。`});
 })},
 onImportJson(){wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:result=>{
  const file=result.tempFiles[0];if(!file)return;
  void this.run(async()=>{
   const imported=await importSharedBankJson(await readFile(file.path));
   wx.redirectTo({url:`/pages/index/index?bank=${encodeURIComponent(imported.bankId)}`});
  });
 },fail:error=>{if(!/cancel/i.test(error.errMsg||''))this.setData({error:error.errMsg||'无法打开聊天文件'})}})},
 async run(action:()=>Promise<void>){if(this.data.busy)return;this.setData({busy:true,error:'',notice:''});try{await action()}catch(e){this.setData({error:e instanceof Error?e.message:String(e)})}finally{this.setData({busy:false})}},
});
