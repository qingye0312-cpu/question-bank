import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as appearance from '../desktop/shared/appearance.ts';
import {loadPreferences,preferenceKey,defaults} from '../desktop/src/preferences.ts';
import {applyAppearance,systemScheme,watchSystemScheme} from '../desktop/src/appearance.ts';
const {themes,themeTokens,themeStyle,appearanceDefaults,normalizeAppearance,resolveAppearance}=appearance;

function contrast(a,b){
 const luminance=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
 const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
test('every day/night palette provides readable text, controls, answers and twelve themed search marks',()=>{
 for(const theme of themes)for(const scheme of ['light','dark']){
  const t=themeTokens(theme.id,scheme),other=themeTokens(theme.id,scheme==='light'?'dark':'light');
  for(const [fg,bg] of [['ink','page'],['ink','surface'],['secondary','page'],['muted','page'],['on-accent','accent'],['on-accent','accent-hover'],['accent','tint'],['accent','selected'],['correct','correct-bg'],['danger','danger-bg'],['warning','warning-bg'],['info','info-bg']]){
   assert.ok(contrast(t[fg],t[bg])>=4.5,`${theme.id}/${scheme} ${fg}/${bg}: ${contrast(t[fg],t[bg])}`);
  }
  const marks=Array.from({length:12},(_,i)=>t[i?`highlight-${i}`:'highlight']);
  assert.equal(new Set(marks).size,12);
  for(const bg of marks)assert.ok(contrast(t['highlight-ink'],bg)>=4.5,`${theme.id}/${scheme} highlight`);
  assert.notEqual(t.highlight,other.highlight);assert.notEqual(t.selected,other.selected);
  assert.ok(themeStyle(theme.id,scheme).includes(`--highlight:${t.highlight}`));
 }
 assert.equal(new Set(themes.map(t=>themeTokens(t.id,'light').highlight)).size,themes.length);
});
test('switching system appearance uses independent saved day/night selections',()=>{
 const p={themeMode:'system',lightTheme:'amber',darkTheme:'ocean'};
 assert.deepEqual(resolveAppearance(p,'light'),{scheme:'light',theme:'amber'});
 assert.deepEqual(resolveAppearance(p,'dark'),{scheme:'dark',theme:'ocean'});
 assert.deepEqual(resolveAppearance({...p,themeMode:'light'},'dark'),{scheme:'light',theme:'amber'});
 assert.deepEqual(resolveAppearance({...p,themeMode:'dark'},'light'),{scheme:'dark',theme:'ocean'});
 assert.deepEqual(p,{themeMode:'system',lightTheme:'amber',darkTheme:'ocean'});
 assert.deepEqual(normalizeAppearance({theme:'night'}),{themeMode:'dark',lightTheme:'forest',darkTheme:'forest'});
 assert.deepEqual(normalizeAppearance({theme:'ocean'}),{themeMode:'light',lightTheme:'ocean',darkTheme:'forest'});
 assert.deepEqual(normalizeAppearance({themeMode:'oops',lightTheme:'missing',darkTheme:null}),appearanceDefaults);
 assert.deepEqual(normalizeAppearance(null),appearanceDefaults);
});
test('merged palettes migrate legacy and separately saved day/night preferences',()=>{
 assert.deepEqual(themes.map(t=>t.label),['海蓝','紫藤','樱粉','朱砂','暖杏','秋金','松绿','石墨']);
 for(const [old,now] of [['blue','ocean'],['purple','violet'],['orange','amber'],['green','forest'],['gray','slate'],['night','forest']]){
  assert.deepEqual(normalizeAppearance({themeMode:'system',lightTheme:old,darkTheme:old}),{themeMode:'system',lightTheme:now,darkTheme:now});
 }
});
test('desktop v1/v2 preferences migrate without losing font, bank, layout or legacy theme',()=>{
 const storage=new Map();globalThis.localStorage={getItem:key=>storage.get(key)||null};
 try{
  storage.set('question-bank.appearance.v1',JSON.stringify({theme:'ocean',fontSize:'xlarge',mode:'speed',bankId:'bank',speedPreview:true,sidebarCollapsed:true}));
  const legacy=loadPreferences();assert.equal(legacy.fontSize,'medium');assert.equal(legacy.lightTheme,'ocean');assert.equal(legacy.bankId,'bank');assert.equal(legacy.mode,'speed');assert.equal(legacy.speedPreview,true);assert.equal(legacy.sidebarCollapsed,true);
  storage.set('question-bank.appearance.v2',JSON.stringify({...legacy,themeMode:undefined,lightTheme:undefined,darkTheme:undefined,theme:'night',fontSize:'xlarge'}));
  assert.equal(loadPreferences().fontSize,'xlarge');assert.equal(loadPreferences().themeMode,'dark');
  const latest={...legacy,themeMode:'system',lightTheme:'red',darkTheme:'yellow'};
  storage.set(preferenceKey,JSON.stringify(latest));assert.deepEqual(loadPreferences(),latest);
  storage.set(preferenceKey,'broken');assert.deepEqual(loadPreferences(),defaults);
 }finally{delete globalThis.localStorage;}
});
test('desktop system listener applies palette, marks and native control scheme and removes listener',()=>{
 let callback;const properties=new Map(),root={dataset:{},style:{setProperty:(k,v)=>properties.set(k,v)}};
 const media={matches:false,addEventListener:(_,fn)=>callback=fn,removeEventListener:(_,fn)=>{assert.equal(fn,callback);callback=undefined;}};
 globalThis.window={matchMedia:()=>media};globalThis.document={documentElement:root};
 try{
  const p={themeMode:'system',lightTheme:'pink',darkTheme:'slate'};
  assert.equal(systemScheme(),'light');
  const stop=watchSystemScheme(scheme=>applyAppearance(p,scheme));
  assert.equal(root.dataset.theme,'pink');const lightMark=properties.get('--highlight');
  media.matches=true;callback();assert.equal(root.dataset.theme,'slate');assert.equal(root.style.colorScheme,'dark');assert.notEqual(properties.get('--highlight'),lightMark);
  assert.equal(properties.get('--highlight-ink'),themeTokens('slate','dark')['highlight-ink']);
  applyAppearance(p,'dark','light');assert.equal(root.dataset.theme,'pink');assert.equal(root.style.colorScheme,'light');assert.equal(root.dataset.themeMode,'system');
  applyAppearance(p,'dark');assert.equal(root.dataset.theme,'slate');assert.equal(root.style.colorScheme,'dark');
  stop();assert.equal(callback,undefined);
 }finally{delete globalThis.window;delete globalThis.document;}
});

function mobileTheme(saved){
 const storage=new Map(saved?[['qbank-appearance-v1',saved]]:[]),navigation=[],background=[],modules=new Map();let system='light',failStorage=false;
 const wx={getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>{if(failStorage)throw Error('full');storage.set(key,value);},
  getAppBaseInfo:()=>({theme:system}),setNavigationBarColor:o=>navigation.push(o),setBackgroundColor:o=>background.push(o),setBackgroundTextStyle:()=>{}};
 const load=relative=>{
  if(modules.has(relative))return modules.get(relative);
  const exports={};modules.set(relative,exports);
  const source=readFileSync(new URL(`../miniprogram/miniprogram/${relative}`,import.meta.url),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
    {exports,wx,require:name=>{assert.equal(name,'../core/appearance');return appearance;}});
  return exports;
 };
 const service=load('services/appearance.ts');
 const page=()=>({data:{},writes:0,setData(value){this.writes++;Object.assign(this.data,JSON.parse(JSON.stringify(value)));}});
 return {storage,navigation,background,service,page,wx,setSystem:v=>system=v,failStorage:()=>failStorage=true};
}
test('Mini Program persists separate palettes, follows system in visible page and colors native chrome',()=>{
 const m=mobileTheme({themeMode:'system',lightTheme:'yellow',darkTheme:'purple'}),p=m.page();
 m.service.showPageTheme(p);assert.equal(p.data.themeScheme,'light');assert.match(p.data.themeStyle,/--highlight:/);
 m.setSystem('dark');m.service.systemThemeChanged({theme:'dark'});
 assert.equal(p.data.themeScheme,'dark');assert.equal(m.navigation.at(-1).frontColor,'#ffffff');
 assert.equal(m.background.at(-1).backgroundColor,themeTokens('violet','dark').page);
 assert.equal(p.data.themeStyle,themeStyle('violet','dark'));
 m.service.saveAppearance({...p.data.appearance,themeMode:'light'});m.service.systemThemeChanged({theme:'dark'});
 assert.equal(p.data.themeStyle,themeStyle('yellow','light'));assert.equal(m.navigation.at(-1).frontColor,'#000000');
 const saved=m.storage.get('qbank-appearance-v1');assert.equal(saved.darkTheme,'violet');assert.equal(saved.lightTheme,'yellow');
 const restored=mobileTheme(saved),next=restored.page();restored.setSystem('dark');restored.service.showPageTheme(next);
 assert.equal(next.data.themeScheme,'light');assert.deepEqual(next.data.appearance,p.data.appearance);
});
test('Mini Program resumes with latest scheme, does not update hidden pages and handles storage failure',()=>{
 const m=mobileTheme({themeMode:'system',lightTheme:'green',darkTheme:'blue'}),first=m.page(),second=m.page();
 m.service.showPageTheme(first);m.service.hidePageTheme(first);const writes=first.writes;
 m.setSystem('dark');m.service.refreshSystemTheme();assert.equal(first.writes,writes);
 m.service.showPageTheme(second);m.service.hidePageTheme(first);m.service.systemThemeChanged({theme:'light'});
 assert.equal(second.data.themeScheme,'light');assert.equal(first.writes,writes);
 m.service.hidePageTheme(second);m.service.showPageTheme(first);assert.equal(first.data.themeScheme,'dark');
 m.failStorage();assert.equal(m.service.saveAppearance({themeMode:'dark',lightTheme:'red',darkTheme:'amber'}),false);
 assert.equal(first.data.themeStyle,themeStyle('amber','dark'));
 delete m.wx.getAppBaseInfo;m.wx.getSystemInfoSync=()=>({theme:'light'});
 m.service.saveAppearance({themeMode:'system',lightTheme:'red',darkTheme:'amber'});m.service.refreshSystemTheme();assert.equal(first.data.themeScheme,'light');
});
test('Mini Program settings preview overrides the whole visible page, then restores the latest actual mode',()=>{
 const m=mobileTheme({themeMode:'system',lightTheme:'amber',darkTheme:'ocean'}),settings=m.page(),home=m.page();
 m.service.showPageTheme(settings,'dark');
 assert.equal(settings.data.themeStyle,themeStyle('ocean','dark'));assert.equal(m.navigation.at(-1).frontColor,'#ffffff');
 assert.equal(m.service.currentAppearanceScheme(),'light');
 m.service.saveAppearance({...settings.data.appearance,darkTheme:'red'});
 assert.equal(settings.data.themeStyle,themeStyle('red','dark'));
 assert.equal(m.storage.get('qbank-appearance-v1').themeMode,'system');
 m.service.setThemePreview(settings,'light');
 m.setSystem('dark');m.service.systemThemeChanged({theme:'dark'});
 assert.equal(settings.data.themeStyle,themeStyle('amber','light'));assert.equal(m.navigation.at(-1).frontColor,'#000000');
 m.service.hidePageTheme(settings);m.service.showPageTheme(home);
 assert.equal(home.data.themeStyle,themeStyle('red','dark'));assert.equal(m.navigation.at(-1).frontColor,'#ffffff');
 m.service.setThemePreview(settings,'light');assert.equal(home.data.themeScheme,'dark');
 m.service.saveAppearance({...home.data.appearance,themeMode:'light'});
 m.service.showPageTheme(settings,'dark');m.service.hidePageTheme(settings);m.service.showPageTheme(home);
 assert.equal(home.data.themeStyle,themeStyle('amber','light'));
});
