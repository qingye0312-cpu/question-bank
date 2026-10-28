import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
type Update={configured:boolean;version?:string;notes?:string};
export function SoftwareUpdate({busy,onBusy}:{busy:boolean;onBusy:(busy:boolean)=>void}){
 const [update,setUpdate]=useState<Update|null>(null),[message,setMessage]=useState(''),[working,setWorking]=useState(false);
 const active=useRef(true),locked=useRef(false);
 useEffect(()=>{active.current=true;void check();return()=>{active.current=false;};},[]);
 async function check(){if(locked.current)return;locked.current=true;setWorking(true);
  try{const next=await invoke<Update>('software_update_check');if(active.current){setUpdate(next);setMessage(!next.configured?'此构建尚未配置软件更新源。':next.version?`有新版本 ${next.version}`:'当前已经是最新版本。');}}
  catch(e){if(active.current)setMessage(`检查更新失败，当前版本可继续使用：${String(e)}`);}
  finally{locked.current=false;if(active.current)setWorking(false);}
 }
 async function install(){if(!update?.version||locked.current||busy)return;if(!window.confirm(`安装 ${update.version} 并重启题库？请先保存正在编辑的内容。`))return;
  locked.current=true;setWorking(true);onBusy(true);setMessage('正在下载并校验更新…');let stop:(()=>void)|undefined;
  try{stop=await listen<{downloaded:number;total?:number}>('software-update-progress',e=>{if(active.current)setMessage(`已下载 ${(e.payload.downloaded/1048576).toFixed(1)} MB${e.payload.total?` / ${(e.payload.total/1048576).toFixed(1)} MB`:''}`);});await invoke('software_update_install',{version:update.version});}
  catch(e){if(active.current)setMessage(`更新未完成：${String(e)}`);}
  finally{stop?.();locked.current=false;onBusy(false);if(active.current)setWorking(false);}
 }
 return <section className="callout settings-update"><div className="settings-update-info"><b>软件更新</b><p role="status">{working&&!message?'正在检查…':message}</p>{update?.notes&&<p className="pre-wrap">{update.notes}</p>}</div><div className="settings-update-actions"><button disabled={busy||working} onClick={()=>void check()}>检查软件更新</button>{update?.version&&<button disabled={busy||working} onClick={()=>void install()}>下载并安装 {update.version}</button>}</div></section>;
}
