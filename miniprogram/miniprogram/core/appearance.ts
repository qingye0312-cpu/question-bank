// Generated from shared/appearance.ts.
// Shared by the desktop and Mini Program. Use solid colors: older WebViews do
// not consistently support color-mix(), including inside highlighted text.
export const themes = [
  {id:'ocean', label:'海蓝', color:'#285fa1', light:'#285fa1', dark:'#8bbbea'},
  {id:'violet', label:'紫藤', color:'#7354a0', light:'#7354a0', dark:'#c6aceb'},
  {id:'pink', label:'樱粉', color:'#f944a3', light:'#a62f70', dark:'#ff9cce'},
  {id:'red', label:'朱砂', color:'#ff4b55', light:'#b33039', dark:'#ff999f'},
  {id:'amber', label:'暖杏', color:'#955e24', light:'#955e24', dark:'#dfbc8b'},
  {id:'yellow', label:'秋金', color:'#ffc700', light:'#806300', dark:'#f5d45c'},
  {id:'forest', label:'松绿', color:'#236752', light:'#236752', dark:'#86c7b3'},
  {id:'slate', label:'石墨', color:'#526073', light:'#526073', dark:'#aabbd1'},
] as const;
export type ThemeId = typeof themes[number]['id'];
export type ColorScheme = 'light' | 'dark';
export type ThemeMode = ColorScheme | 'system';
export const themeModes = [
  {id:'light', label:'白天'}, {id:'dark', label:'黑夜'}, {id:'system', label:'跟随系统'},
] as const;
export type AppearancePreferences = {themeMode:ThemeMode; lightTheme:ThemeId; darkTheme:ThemeId};
export const appearanceDefaults:AppearancePreferences = {themeMode:'light',lightTheme:'forest',darkTheme:'forest'};

export function isThemeId(value:unknown):value is ThemeId { return themes.some(t=>t.id===value); }
function migrateTheme(value:unknown):ThemeId|undefined {
  if(isThemeId(value))return value;
  const aliases=[['blue','ocean'],['purple','violet'],['orange','amber'],['green','forest'],['gray','slate'],['night','forest']] as const;
  return aliases.find(([old])=>old===value)?.[1];
}
export function normalizeAppearance(value:unknown):AppearancePreferences {
  const saved = value && typeof value==='object' ? value as Record<string,unknown> : {};
  const legacy = migrateTheme(saved.theme),legacyDark=saved.theme==='night';
  return {
    themeMode:themeModes.some(m=>m.id===saved.themeMode) ? saved.themeMode as ThemeMode : legacyDark ? 'dark' : 'light',
    lightTheme:migrateTheme(saved.lightTheme) || (!legacyDark && legacy) || appearanceDefaults.lightTheme,
    darkTheme:migrateTheme(saved.darkTheme) || appearanceDefaults.darkTheme,
  };
}
export function resolveAppearance(preferences:AppearancePreferences, system:ColorScheme, preview:ColorScheme|null=null) {
  const scheme = preview || (preferences.themeMode==='system' ? system : preferences.themeMode);
  return {scheme,theme:scheme==='dark' ? preferences.darkTheme : preferences.lightTheme};
}

function mix(color:string, background:string, amount:number):string {
  const channels = [1,3,5].map(i=>Math.round(parseInt(color.slice(i,i+2),16)*amount + parseInt(background.slice(i,i+2),16)*(1-amount)));
  return '#'+channels.map(n=>n.toString(16).padStart(2,'0')).join('');
}
function hueColor(hue:number):string {
  const channel=(offset:number)=>{
    const k=(offset+hue/30)%12;
    return Math.round(255*(0.5-0.36*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');
  };
  return '#'+channel(0)+channel(8)+channel(4);
}
function hueOf(color:string):number {
  const [r,g,b]=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
  const max=Math.max(r,g,b),delta=max-Math.min(r,g,b);
  if(!delta)return 210;
  return ((max===r ? (g-b)/delta : max===g ? (b-r)/delta+2 : (r-g)/delta+4)*60+360)%360;
}

export function themeTokens(id:ThemeId, scheme:ColorScheme):Record<string,string> {
  const theme=themes.find(t=>t.id===id)||themes.find(t=>t.id==='forest')!,dark=scheme==='dark';
  const accent=theme[scheme], seed=theme.color;
  const page=dark ? mix(seed,'#151b1e',0.035) : mix(seed,'#ffffff',0.025);
  const surface=dark ? mix(seed,'#20262a',0.035) : '#ffffff';
  const tint=mix(accent,surface,dark ? 0.12 : 0.075);
  const tokens:Record<string,string> = {
    accent,'on-accent':dark ? '#142029' : '#ffffff',
    'accent-hover':mix(accent,dark ? '#ffffff' : '#000000',dark ? 0.82 : 0.84),
    ink:dark ? '#edf1f5' : mix(seed,'#202832',0.08),
    secondary:dark ? '#c6cfd9' : '#4c5965',muted:dark ? '#a4b1be' : '#63717d',
    page,surface,'surface-soft':mix(accent,surface,dark ? 0.045 : 0.025),
    sidebar:dark ? mix(seed,'#1c2226',0.04) : tint,tint,
    selected:mix(accent,surface,dark ? 0.18 : 0.12),
    line:mix(accent,surface,dark ? 0.15 : 0.13),
    border:mix(accent,surface,dark ? 0.3 : 0.25),
    'accent-border':mix(accent,surface,dark ? 0.65 : 0.6),
    correct:accent,'correct-bg':tint,'correct-border':mix(accent,surface,0.6),
    'highlight-ink':dark ? '#f6f8fc' : '#18222e',
    danger:dark ? '#f0a396' : '#a43c32','danger-bg':dark ? '#482b27' : '#fff1ed',
    warning:dark ? '#e3c78f' : '#805c20','warning-bg':dark ? '#423b29' : '#f6efdf',
    info:dark ? '#adcde3' : '#426782','info-bg':dark ? '#283b45' : '#e9eff2',
    'focus-ring':mix(accent,surface,0.25),
    shadow:dark ? '#00000066' : '#17251c26','shadow-soft':dark ? '#00000033' : '#17251c0a',
    overlay:dark ? '#00000099' : '#12201966',
  };
  // The previous night palette is now the dark half of the forest family.
  if(id==='forest'&&dark)Object.assign(tokens,{
    'on-accent':'#142b24',ink:'#e3eee9',secondary:'#c0cec7',muted:'#a3b7ad',
    page:'#151e1c',surface:'#1c2823','surface-soft':'#202e28',sidebar:'#1b2722',
    tint:'#263a31',selected:'#2c4338',line:'#2e4137',border:'#3e574a','accent-border':'#658e79',
    'correct-bg':'#263a31','correct-border':'#658e79',
  });
  // A term keeps its index across the stem, options and metadata. Rotate the
  // remaining hues relative to the chosen palette rather than fixing yellow.
  for(let index=0;index<12;index++){
    const color=index===0 ? (dark ? accent : seed) : hueColor((hueOf(seed)+index*137.508)%360);
    tokens[index===0 ? 'highlight' : `highlight-${index}`]=mix(color,dark ? '#202830' : '#ffffff',dark ? 0.4 : 0.27);
  }
  return tokens;
}
export function themeStyle(id:ThemeId,scheme:ColorScheme):string {
  return Object.entries(themeTokens(id,scheme)).map(([key,value])=>`--${key}:${value}`).join(';')+`;color-scheme:${scheme}`;
}
