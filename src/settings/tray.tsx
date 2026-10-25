import {useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import './tray.css';

const styles = [
 {id:'system',label:'跟随系统',description:'自动适配明暗'},
 {id:'white',label:'白色镂空',description:'适合深色栏'},
 {id:'black',label:'黑色镂空',description:'适合浅色栏'},
 {id:'color',label:'原版彩色',description:'绿色图标'},
] as const;
type TrayStyle=typeof styles[number]['id'];

export function TraySettings({available,platform}:{available:boolean;platform:string}){
 const [style,setStyle]=useState<TrayStyle|null>(null);
 const [saving,setSaving]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
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
  changing.current=true;setSaving(true);setError('');setSaved(false);
  try{
   const applied=await invoke<TrayStyle>('set_tray_style',{style:next});
   if(mounted.current){setStyle(applied);setSaved(true)}
  }catch(reason){if(mounted.current)setError(String(reason))}
  finally{changing.current=false;if(mounted.current)setSaving(false)}
 }
 return <section className="tray-settings" aria-labelledby="tray-settings-title">
  <h3 id="tray-settings-title">状态栏 / 托盘图标</h3>
  <p className="appearance-note">{platform==='macos'?'菜单栏使用标准尺寸图标，跟随系统时自动适配菜单栏明暗。':'macOS 菜单栏与 Windows 系统托盘均可切换；跟随系统时自动适配明暗。'}</p>
  <div className="tray-style-options" role="group" aria-label="状态栏图标样式" aria-busy={saving}>
   {styles.map(option=><button type="button" key={option.id} aria-pressed={style===option.id} disabled={!native||!available||style===null||saving} onClick={()=>void choose(option.id)}>
    <span className={`tray-style-preview tray-preview-${option.id}`} aria-hidden="true"><i/></span>
    <span>{option.label}<small>{option.description}</small></span>
   </button>)}
  </div>
  <p className="tray-style-feedback" role={error?'alert':'status'}>{error||(!native?'请在桌面应用中设置图标。':!available?'系统托盘暂不可用。':saving?'正在应用图标样式…':style===null?'正在读取图标样式…':saved?'图标样式已保存，下次启动继续使用。':'选择后立即生效，并自动保存。')}</p>
 </section>;
}
