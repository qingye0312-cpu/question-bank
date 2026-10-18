import {appearanceDefaults,normalizeAppearance,resolveAppearance,themeStyle,themeTokens,themes,type AppearancePreferences,type ColorScheme} from '../core/appearance';

export const appearanceKey='qbank-appearance-v1';
let preferences:AppearancePreferences|undefined,system:ColorScheme='light';
type ThemePageData={themeStyle:string;appearance:AppearancePreferences;themeScheme:ColorScheme;themeStatus:string};
type ThemePage={setData:(data:ThemePageData)=>void};
let activePage:ThemePage|undefined,previewScheme:ColorScheme|null=null;

function readSystem():ColorScheme {
  try {
    // Newer clients expose theme through getAppBaseInfo; retain the older API
    // for clients whose base library predates the split system-info methods.
    const api=wx as WechatMiniprogram.Wx & {getAppBaseInfo?:()=>{theme?:ColorScheme}};
    const value=api.getAppBaseInfo ? api.getAppBaseInfo().theme : wx.getSystemInfoSync?.().theme;
    if(value==='dark'||value==='light')return value;
  } catch { /* Offline use must also work on older base libraries. */ }
  return system;
}
export function appearancePreferences():AppearancePreferences {
  if(!preferences){
    try { preferences=normalizeAppearance(wx.getStorageSync(appearanceKey)); }
    catch { preferences={...appearanceDefaults}; }
    system=readSystem();
  }
  return {...preferences};
}
export function themePageData():ThemePageData {
  const appearance=appearancePreferences(),{theme,scheme}=resolveAppearance(appearance,system,previewScheme);
  const label=themes.find(t=>t.id===theme)!.label;
  return {appearance,themeStyle:themeStyle(theme,scheme),themeScheme:scheme,
    themeStatus:`${previewScheme?'正在预览 · ':appearance.themeMode==='system'?'跟随系统 · ':''}${scheme==='dark'?'黑夜':'白天'} · ${label}`};
}
export function currentAppearanceScheme():ColorScheme {return resolveAppearance(appearancePreferences(),system).scheme;}
function updateNative():void {
  const {theme,scheme}=resolveAppearance(appearancePreferences(),system,previewScheme),background=themeTokens(theme,scheme).page;
  // This updates the native navigation and overscroll areas as well as WXML.
  wx.setNavigationBarColor?.({frontColor:scheme==='dark'?'#ffffff':'#000000',backgroundColor:background,fail:()=>{}});
  wx.setBackgroundColor?.({backgroundColor:background,backgroundColorTop:background,backgroundColorBottom:background,fail:()=>{}});
  wx.setBackgroundTextStyle?.({textStyle:scheme==='dark'?'light':'dark',fail:()=>{}});
}
function render():void { if(activePage){activePage.setData(themePageData());updateNative();} }
export function showPageTheme(page:ThemePage,preview:ColorScheme|null=null):void {appearancePreferences();system=readSystem();activePage=page;previewScheme=preview;render();}
export function setThemePreview(page:ThemePage,scheme:ColorScheme):void {if(activePage===page){previewScheme=scheme;render();}}
export function hidePageTheme(page:ThemePage):void {if(activePage===page){activePage=undefined;previewScheme=null;}}
export function refreshSystemTheme():void {appearancePreferences();system=readSystem();render();}
export function systemThemeChanged(event:{theme:ColorScheme}):void {appearancePreferences();system=event.theme;render();}
export function saveAppearance(value:AppearancePreferences):boolean {
  preferences=normalizeAppearance(value);render();
  try {wx.setStorageSync(appearanceKey,preferences);return true;}
  catch {return false;}
}
