import type {Dispatch,SetStateAction} from 'react';
import {Check} from 'lucide-react';
import {fontSizes,themes,defaults,type Preferences} from '../preferences';
export function AppearanceSettings({preferences,setPreferences}:{preferences:Preferences;setPreferences:Dispatch<SetStateAction<Preferences>>}){return (    <section className="appearance-settings" aria-label="显示设置">
     <h3>字体大小</h3><div className="font-options" role="group" aria-label="字体大小">{fontSizes.map(f=><button key={f.id} aria-pressed={preferences.fontSize===f.id} className={preferences.fontSize===f.id?'active':''} onClick={()=>setPreferences(p=>({...p,fontSize:f.id}))}>{f.label}{f.id==='medium'&&<small>默认</small>}</button>)}</div>
     <h3>页面配色</h3><div className="theme-options" role="group" aria-label="页面配色">{themes.map(t=><button key={t.id} aria-pressed={preferences.theme===t.id} className={preferences.theme===t.id?'active':''} onClick={()=>setPreferences(p=>({...p,theme:t.id}))}><i style={{backgroundColor:t.color}}/>{t.label}{preferences.theme===t.id&&<Check size={13}/>}</button>)}</div>
     <div className="appearance-preview"><span>字号与配色实时预览</span><b>找到问题，也找到答案。</b><small>标准沿用原超大字号；字号和布局一起缩放。</small></div>
     <button className="text-button" onClick={()=>setPreferences(p=>({...p,fontSize:defaults.fontSize,theme:defaults.theme}))}>恢复默认显示</button>
    </section>);}
