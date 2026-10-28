import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import './tray.css';

const styles = [
 {id:'system',label:'自动'},
 {id:'color',label:'彩色'},
] as const;
type TrayStyle=typeof styles[number]['id'];

export function TraySettings({available}:{available:boolean}){
 const [style,setStyle]=useState<TrayStyle|null>(null);
 const [saving,setSaving]=useState(false),[error,setError]=useState('');
 const changing=useRef(false);
 const mounted=useRef(false);
 const native=isTauri();
 useEffect(()=>{
  mounted.current=true;
  let active=true;
  if(native)void invoke<TrayStyle>('get_tray_style').then(value=>{if(active)setStyle(value)}).catch(reason=>{if(active)setError(String(reason))});
  return()=>{active=false;mounted.current=false};
 },[native]);
 async function choose(next:TrayStyle){
  if(changing.current||!available||!native||next===style)return;
  changing.current=true;setSaving(true);setError('');
  try{
   const applied=await invoke<TrayStyle>('set_tray_style',{style:next});
   if(mounted.current)setStyle(applied);
  }catch(reason){if(mounted.current)setError(String(reason))}
  finally{changing.current=false;if(mounted.current)setSaving(false)}
 }
 return <section className="tray-settings" aria-labelledby="tray-settings-title">
  <div className="tray-settings-copy">
   <h3 id="tray-settings-title">状态栏 / 托盘图标</h3>
   <p className="appearance-note">状态栏使用标准尺寸图标，跟随系统时自动适配明暗。</p>
  </div>
  <div className="tray-style-options" role="group" aria-label="状态栏图标样式" aria-busy={saving}>
   {styles.map(option=><button type="button" key={option.id} aria-pressed={style===option.id} disabled={!native||!available||style===null||saving} onClick={()=>void choose(option.id)}>
    <span className={`tray-style-preview tray-preview-${option.id}`} aria-hidden="true"><i/></span>
    <span>{option.label}</span>
   </button>)}
  </div>
  {error&&<span className="tray-style-error" role="alert">{error}</span>}
 </section>;
}
