import {appearanceDefaults,themeModes,themes,themeStyle,isThemeId,type ColorScheme} from '../../core/appearance';
import {themePageData,showPageTheme,hidePageTheme,saveAppearance,setThemePreview,currentAppearanceScheme} from '../../services/appearance';

Page({
 data:{...themePageData(),modes:themeModes,themes,editing:'light' as ColorScheme,previewStyle:'',selectedTheme:'forest',selectedLabel:'松绿',saveNotice:''},
 onLoad(){this.setData({editing:currentAppearanceScheme()});this.updatePreview();},
 onShow(){showPageTheme(this,this.data.editing);this.updatePreview();},
 onHide(){hidePageTheme(this);},
 onUnload(){hidePageTheme(this);},
 updatePreview(){
  const {editing,appearance}=this.data,id=editing==='light'?appearance.lightTheme:appearance.darkTheme;
  this.setData({previewStyle:themeStyle(id,editing),selectedTheme:id,selectedLabel:themes.find(t=>t.id===id)!.label});
 },
 save(){const saved=saveAppearance(this.data.appearance);this.setData({saveNotice:saved?'已保存到本机':'本次已生效，但本机存储失败，请稍后重新选择'});this.updatePreview();},
 onMode(event:WechatMiniprogram.TouchEvent){
  const mode=event.currentTarget.dataset.mode;
  if(mode!=='light'&&mode!=='dark'&&mode!=='system')return;
  this.setData({appearance:{...this.data.appearance,themeMode:mode}});this.save();
  this.setData({editing:currentAppearanceScheme()});setThemePreview(this,this.data.editing);this.updatePreview();
 },
 onEditing(event:WechatMiniprogram.TouchEvent){const scheme=event.currentTarget.dataset.scheme;if(scheme!=='light'&&scheme!=='dark')return;this.setData({editing:scheme});setThemePreview(this,scheme);this.updatePreview();},
 onColor(event:WechatMiniprogram.TouchEvent){
  const id=event.currentTarget.dataset.id;if(!isThemeId(id))return;
  this.setData({appearance:{...this.data.appearance,[this.data.editing==='light'?'lightTheme':'darkTheme']:id}});this.save();
 },
 onReset(){this.setData({appearance:{...appearanceDefaults},editing:'light'});this.save();setThemePreview(this,'light');},
});
