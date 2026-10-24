import {useState} from 'react';
import {cloudAccess,cloudLogin,cloudLoginPassword,cloudLogout,cloudOrigin,setCloudOrigin,remembersMachine,resumeDesktop,cloudForget} from '../cloud-client';

type LoginMode='key'|'account';

export function CloudLogin({onChange=()=>{},disabled=false}:{onChange?:()=>void;disabled?:boolean}){
 const [origin,setOrigin]=useState(cloudOrigin()),[mode,setMode]=useState<LoginMode>('key');
 const [key,setKey]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const [remember,setRemember]=useState(remembersMachine);
 const access=cloudAccess();
 async function loginKey(){
  if(busy)return;setBusy(true);setMessage('');const secret=key;setKey('');
  try{if(origin!==cloudOrigin())setCloudOrigin(origin);await cloudLogin(secret,remember);setMessage(remember?'最高权限登录成功；已确认任务可自动续取短期会话':'最高权限登录成功，仅用于本次会话');render(n=>n+1);onChange();}
  catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function loginAccount(){
  if(busy)return;setBusy(true);setMessage('');const secret=password;setPassword('');
  try{if(origin!==cloudOrigin())setCloudOrigin(origin);const result=await cloudLoginPassword(username,secret);
   const status=result.account_status==='approved'?'已获桌面管理员授权':result.account_status==='rejected'?'申请未通过，可重新申请':'等待桌面管理员审批';
   setMessage(`账号密码登录成功，${status}`);render(n=>n+1);onChange();
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 const statusLabel=access?.account_status==='approved'?'已授权':access?.account_status==='pending'?'等待管理员审批':access?.account_status==='rejected'?'申请未通过':access?.account_status==='password_reset_required'?'等待重置密码':access?.account_status==='desktop'?'最高权限':'';
 return <div className="cloud-access"><p>日常搜题与本地录题无需登录。维护者账号密码仅获得经审批的题库上传权限；最高权限继续使用维护者密钥或证书。</p>
  <label>云端 HTTPS 地址<input value={origin} disabled={disabled||busy} onChange={e=>setOrigin(e.target.value)}/></label>
  <button disabled={disabled||busy||!origin} onClick={()=>{try{setCloudOrigin(origin);render(n=>n+1);setMessage('地址已保存');onChange();}catch(e){setMessage(String(e));}}}>保存服务地址</button>
  {access?<><p>已登录：{access.auth_type==='password'?access.username||'维护者账号':access.auth_type==='key'?'最高权限密钥':'维护者账号'}{statusLabel?` · ${statusLabel}`:''}</p><p>已授权题库：{access.banks.map(b=>b.name).join('、')||'暂无'}</p><button disabled={disabled||busy} onClick={()=>{cloudLogout();render(n=>n+1);onChange();}}>退出维护者登录</button></>:<>
   <div className="cloud-login-mode" role="group" aria-label="登录方式"><button type="button" aria-pressed={mode==='key'} disabled={disabled||busy} onClick={()=>{setMode('key');setMessage('');}}>最高权限密钥</button><button type="button" aria-pressed={mode==='account'} disabled={disabled||busy} onClick={()=>{setMode('account');setMessage('');}}>账号密码</button></div>
   {mode==='key'?<>
    <label><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} disabled={disabled||busy}/>记住本机（系统钥匙串／凭据管理器）</label>
    <label>维护者密钥<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={disabled||busy} onChange={e=>setKey(e.target.value)}/></label>
    <button disabled={disabled||busy||!key} onClick={()=>void loginKey()}>{busy?'正在验证…':'维护者密钥登录'}</button>
   </>:<>
    <label>维护者账号<input autoComplete="username" spellCheck={false} value={username} disabled={disabled||busy} onChange={e=>setUsername(e.target.value)}/></label>
    <label>密码<input type="password" autoComplete="current-password" value={password} disabled={disabled||busy} onChange={e=>setPassword(e.target.value)}/></label>
    <button disabled={disabled||busy||!username||!password} onClick={()=>void loginAccount()}>{busy?'正在登录…':'账号密码登录'}</button>
   </>}
  </>}
  {remembersMachine()&&<><button disabled={disabled||busy} onClick={()=>{void resumeDesktop().then(()=>{render(n=>n+1);onChange()}).catch(e=>setMessage(String(e)))}}>使用本机凭据登录</button><button disabled={disabled||busy} onClick={()=>{void cloudForget().then(()=>{setRemember(false);render(n=>n+1)}).catch(e=>setMessage(String(e)))}}>移除本机凭据</button></>}
  {message&&<p role="status">{message}</p>}
 </div>;
}
