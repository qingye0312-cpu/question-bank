import {useState} from 'react';
import {cloudAccess,cloudLogin,cloudLogout,cloudOrigin,setCloudOrigin,remembersMachine,resumeDesktop,cloudForget} from '../cloud-client';
export function CloudLogin({onChange=()=>{},disabled=false}:{onChange?:()=>void;disabled?:boolean}){
 const [origin,setOrigin]=useState(cloudOrigin),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const [remember,setRemember]=useState(remembersMachine);
 const access=cloudAccess();
 async function login(){if(busy)return;setBusy(true);setMessage('');const secret=key;setKey('');try{if(origin!==cloudOrigin())setCloudOrigin(origin);await cloudLogin(secret,remember);setMessage(remember?'维护者登录成功；已确认任务可自动续取短期会话':'维护者登录成功，仅用于本次会话');render(n=>n+1);onChange();}catch(e){setMessage(String(e));}finally{setBusy(false);}}
 return <div className="cloud-access"><p>日常搜题与本地录题无需登录。开发者上传、维护者合并按题库分别授权。</p>
  <label>云端 HTTPS 地址<input value={origin} disabled={disabled||busy} onChange={e=>setOrigin(e.target.value)}/></label>
  <button disabled={disabled||busy||!origin} onClick={()=>{try{setCloudOrigin(origin);render(n=>n+1);setMessage('地址已保存');onChange();}catch(e){setMessage(String(e));}}}>保存服务地址</button>
  {access?<><p>已授权：{access.banks.map(b=>b.name).join('、')}</p><button disabled={disabled||busy} onClick={()=>{cloudLogout();render(n=>n+1);onChange();}}>退出维护者登录</button></>:<><label><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} disabled={disabled||busy}/>记住本机（系统钥匙串／凭据管理器）</label><label>维护者密钥<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={disabled||busy} onChange={e=>setKey(e.target.value)}/></label><button disabled={disabled||busy||!key} onClick={()=>void login()}>{busy?'正在验证…':'维护者登录'}</button></>}
  {remembersMachine()&&<><button disabled={disabled||busy} onClick={()=>{void resumeDesktop().then(()=>{render(n=>n+1);onChange()}).catch(e=>setMessage(String(e)))}}>使用本机凭据登录</button><button disabled={disabled||busy} onClick={()=>{void cloudForget().then(()=>{setRemember(false);render(n=>n+1)}).catch(e=>setMessage(String(e)))}}>移除本机凭据</button></>}
  {message&&<p role="status">{message}</p>}
 </div>;
}
