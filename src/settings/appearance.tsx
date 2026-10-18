import {useLayoutEffect,useState,type CSSProperties,type Dispatch,type SetStateAction} from 'react';
import {Check,Sun,Moon,Monitor} from 'lucide-react';
import {fontSizes,defaults,type Preferences} from '../preferences';
import {themes,themeModes,themeTokens,type ColorScheme} from '../../shared/appearance';

export function AppearanceSettings({preferences,setPreferences,systemTheme,setPreview}:{preferences:Preferences;setPreferences:Dispatch<SetStateAction<Preferences>>;systemTheme:ColorScheme;setPreview:Dispatch<SetStateAction<ColorScheme|null>>}){
 const [editing,setEditing]=useState<ColorScheme>(preferences.themeMode==='system'?systemTheme:preferences.themeMode);
 useLayoutEffect(()=>{setPreview(editing);return()=>setPreview(null)},[editing,setPreview]);
 const chosen=editing==='light'?preferences.lightTheme:preferences.darkTheme;
 const previewTokens=themeTokens(chosen,editing);
 const previewStyle=Object.fromEntries(Object.entries(previewTokens).map(([key,value])=>[`--${key}`,value])) as CSSProperties;
 const current=preferences.themeMode==='system'?systemTheme:preferences.themeMode;
 return <section className="appearance-settings" aria-label="显示设置">
  <h3>字体大小</h3>
  <div className="font-options" role="group" aria-label="字体大小">{fontSizes.map(f=><button key={f.id} aria-pressed={preferences.fontSize===f.id} className={preferences.fontSize===f.id?'active':''} onClick={()=>setPreferences(p=>({...p,fontSize:f.id}))}>{f.label}{f.id==='medium'&&<small>默认</small>}</button>)}</div>
  <h3>显示模式</h3>
  <div className="appearance-modes" role="group" aria-label="显示模式">{themeModes.map((m,i)=><button key={m.id} aria-pressed={preferences.themeMode===m.id} onClick={()=>{setPreferences(p=>({...p,themeMode:m.id}));setEditing(m.id==='system'?systemTheme:m.id)}}>{i===0?<Sun/>:i===1?<Moon/>:<Monitor/>}{m.label}</button>)}</div>
  <p className="appearance-note">正在预览{editing==='dark'?'黑夜':'白天'}配色。退出设置后{preferences.themeMode==='system'?`跟随系统，当前为${current==='dark'?'黑夜':'白天'}。`:`恢复${current==='dark'?'黑夜':'白天'}模式。`}两套配色分别保存。</p>
  <div className="palette-tabs" role="group" aria-label="编辑配色">{(['light','dark'] as const).map(s=><button key={s} aria-pressed={editing===s} onClick={()=>setEditing(s)}>{s==='light'?'白天颜色':'黑夜颜色'}<small>{themes.find(t=>t.id===(s==='light'?preferences.lightTheme:preferences.darkTheme))?.label}</small></button>)}</div>
  <div className="theme-options" role="group" aria-label={editing==='light'?'白天颜色':'黑夜颜色'}>{themes.map(t=><button key={t.id} aria-label={t.label} aria-pressed={chosen===t.id} className={chosen===t.id?'active':''} onClick={()=>setPreferences(p=>({...p,[editing==='light'?'lightTheme':'darkTheme']:t.id}))}><i style={{backgroundColor:t[editing]}}/>{t.label}{chosen===t.id&&<Check/>}</button>)}</div>
  <div className="appearance-preview" style={previewStyle}>
   <span>{editing==='light'?'白天':'黑夜'}预览 · {themes.find(t=>t.id===chosen)?.label}</span>
   <b>找到<mark>问题</mark>，也找到<mark data-term="1">答案</mark>。</b>
   <div className="appearance-example"><span>● A　正确答案</span><button type="button">选中状态</button></div>
   <small>搜索高亮、答案标记和选中状态随这套配色变化。</small>
  </div>
  <button className="text-button" onClick={()=>{setPreferences(p=>({...p,fontSize:defaults.fontSize,themeMode:defaults.themeMode,lightTheme:defaults.lightTheme,darkTheme:defaults.darkTheme}));setEditing('light')}}>恢复默认显示</button>
 </section>;
}
