import {useState,type FormEvent} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-dialog';
import {FileKey} from 'lucide-react';
import {cloudAccess,cloudCall,cloudLogin,cloudLoginPassword,cloudLogout,cloudOrigin,setCloudOrigin,remembersMachine,resumeDesktop,cloudForget,fetchCatalog} from '../cloud-client';
import {parseMaintainerCertificate} from './session-service';

type LoginMode='account'|'register'|'key'|'reset';
type BankChoice={bank_id:string;name:string};
function passwordMeetsPolicy(value:string){
 const length=Array.from(value).length;
 return length>=8&&length<=128&&/[A-Z]/.test(value)&&/[a-z]/.test(value)&&/[0-9]/.test(value);
}

export function CloudLogin({onChange=()=>{},disabled=false}:{onChange?:()=>void;disabled?:boolean}){
 const [origin,setOrigin]=useState(cloudOrigin()),[mode,setMode]=useState<LoginMode>('account');
 const [key,setKey]=useState(''),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[confirmPassword,setConfirmPassword]=useState('');
 const [phone,setPhone]=useState(''),[realName,setRealName]=useState(''),[nickname,setNickname]=useState(''),[identityDescription,setIdentityDescription]=useState('');
 const [resetToken,setResetToken]=useState(''),[newPassword,setNewPassword]=useState('');
 const [banks,setBanks]=useState<BankChoice[]>([]),[selectedBanks,setSelectedBanks]=useState<string[]>([]),[banksLoading,setBanksLoading]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const [remember,setRemember]=useState(remembersMachine);
 const access=cloudAccess();
 const registrationPasswordReady=passwordMeetsPolicy(password)&&password===confirmPassword;

 function saveOrigin(){
  try{setCloudOrigin(origin);render(n=>n+1);setMessage('服务地址已保存');onChange();}
  catch(e){setMessage(String(e));}
 }
 async function loadBanks(){
  if(banksLoading)return;
  setBanksLoading(true);setMessage('');
  try{
   if(origin!==cloudOrigin())setCloudOrigin(origin);
   const catalog=await fetchCatalog();
   const choices=catalog.map(bank=>({bank_id:bank.bank_id,name:bank.name}));
   setBanks(choices);
   setSelectedBanks(current=>current.filter(id=>choices.some(bank=>bank.bank_id===id)));
   if(!choices.length)setMessage('服务端当前没有可申请的云端题库。');
  }catch(e){setBanks([]);setSelectedBanks([]);setMessage(`读取云端题库失败：${String(e)}`);}
  finally{setBanksLoading(false);}
 }
 function openRegistration(){setMode('register');setMessage('');setBanks([]);setSelectedBanks([]);void loadBanks();}
 async function loginKey(){
  if(busy)return;setBusy(true);setMessage('');const secret=key;setKey('');
  try{if(origin!==cloudOrigin())setCloudOrigin(origin);await cloudLogin(secret,remember);setMessage(remember?'最高权限登录成功；已确认任务可自动续取短期会话':'最高权限登录成功，仅用于本次会话');render(n=>n+1);onChange();}
  catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function importCertificate(){
  if(busy)return;
  const path=await open({multiple:false,title:'导入最高权限证书',filters:[{name:'最高权限证书',extensions:['json','qbank-cert']}]});
  if(!path||Array.isArray(path))return;
  setBusy(true);setMessage('');
  try{
   if(origin!==cloudOrigin())setCloudOrigin(origin);
   const raw=await invoke<string>('read_text_file',{path});
   const cert=parseMaintainerCertificate(JSON.parse(raw));
   if(cert.service_origin&&cert.service_origin!==cloudOrigin())throw Error('证书服务地址与当前服务地址不一致');
   await cloudLogin(cert.key,remember);
   setMessage(`最高权限证书登录成功：${cert.certificate_id}${remember?'；已保存到本机凭据管理器':'；仅用于本次会话'}`);
   render(n=>n+1);onChange();
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function loginAccount(){
  if(busy)return;setBusy(true);setMessage('');const secret=password;setPassword('');
  try{if(origin!==cloudOrigin())setCloudOrigin(origin);const result=await cloudLoginPassword(username,secret);
   const status=result.account_status==='approved'?'已获桌面管理员授权':result.account_status==='rejected'?'申请未通过，可重新申请':'等待桌面管理员审批';
   setMessage(`账号密码登录成功，${status}`);render(n=>n+1);onChange();
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function registerAccount(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;
  if(!passwordMeetsPolicy(password)){setMessage('密码至少 8 位，且需包含大写字母、小写字母和数字。');return;}
  if(password!==confirmPassword){setMessage('两次输入的密码不一致。');return;}
  if(!selectedBanks.length){setMessage('至少选择一个申请维护的题库。');return;}
  setBusy(true);setMessage('');
  try{
   if(origin!==cloudOrigin())setCloudOrigin(origin);
   await cloudCall('/v1/auth/register',{
    username:username.trim().toLowerCase(),password,phone:phone.trim(),real_name:realName.trim(),nickname:nickname.trim(),
    identity_description:identityDescription.trim(),bank_ids:selectedBanks,
   });
   setPassword('');setConfirmPassword('');setMode('account');
   setMessage('申请已提交，等待桌面最高权限审批。审批通过后，此账号才可上传所选题库。');
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function resetAccountPassword(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;
  if(!passwordMeetsPolicy(newPassword)){setMessage('密码至少 8 位，且需包含大写字母、小写字母和数字。');return;}
  setBusy(true);setMessage('');
  try{
   if(origin!==cloudOrigin())setCloudOrigin(origin);
   await cloudCall('/v1/auth/password-reset',{username:username.trim().toLowerCase(),reset_token:resetToken.trim(),password:newPassword});
   setPassword('');setNewPassword('');setResetToken('');setMode('account');
   setMessage('密码已重置。请重新登录，并等待桌面最高权限再次批准题库权限。');
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 const statusLabel=access?.account_status==='approved'?'已授权':access?.account_status==='pending'?'等待管理员审批':access?.account_status==='rejected'?'申请未通过':access?.account_status==='password_reset_required'?'等待重置密码':access?.account_status==='desktop'?'最高权限':'';
 return <div className="cloud-access"><div className="cloud-access-heading"><h3>云端登录与权限</h3><span>{access?'已登录':'选择登录方式'}</span></div><p>日常搜题与本地录题无需登录。维护者账号需由桌面最高权限审批后，才能上传获批题库；手机号用于唯一登记，当前不发送短信验证码。</p>
  {access?<div className="cloud-session-info"><p>当前身份：{access.auth_type==='password'?access.username||'维护者账号':access.auth_type==='key'?'最高权限（密钥／证书）':'维护者账号'}{statusLabel?` · ${statusLabel}`:''}</p><p>已授权题库：{access.banks.map(b=>b.name).join('、')||'暂无'}</p><div className="cloud-login-actions"><button type="button" disabled={disabled||busy} onClick={()=>{cloudLogout();setMode('account');setMessage('已退出，请选择登录、注册或最高权限。');render(n=>n+1);onChange();}}>退出并切换登录方式</button></div></div>:<>
   <div className="cloud-login-mode" role="group" aria-label="登录方式">
    <button type="button" aria-pressed={mode==='account'||mode==='reset'} disabled={disabled||busy} onClick={()=>{setMode('account');setMessage('');}}>登录</button>
    <button type="button" aria-pressed={mode==='register'} disabled={disabled||busy} onClick={openRegistration}>注册</button>
    <button type="button" aria-pressed={mode==='key'} disabled={disabled||busy} onClick={()=>{setMode('key');setMessage('');}}>最高权限</button>
   </div>
   <div className="cloud-login-panel">{mode==='key'?<>
    <p className="cloud-login-hint">最高权限密钥和分发证书等效，任选一种即可登录。两种方式使用同一最高权限身份。</p>
    <label><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)} disabled={disabled||busy}/>记住本机（系统钥匙串／凭据管理器）</label>
    <label>最高权限密钥<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={disabled||busy} onChange={e=>setKey(e.target.value)}/></label>
    <div className="cloud-login-actions"><button type="button" disabled={disabled||busy||!key} onClick={()=>void loginKey()}>{busy?'正在验证…':'使用密钥登录'}</button><button type="button" disabled={disabled||busy} onClick={()=>void importCertificate()}><FileKey size={16}/>导入证书并登录</button></div>
   </>:mode==='account'?<>
    <label>维护者账号<input autoComplete="username" spellCheck={false} value={username} disabled={disabled||busy} onChange={e=>setUsername(e.target.value)}/></label>
    <label>密码<input type="password" autoComplete="current-password" value={password} disabled={disabled||busy} onChange={e=>setPassword(e.target.value)}/></label>
    <div className="cloud-login-actions cloud-account-actions"><button className="primary" type="button" disabled={disabled||busy||!username||!password} onClick={()=>void loginAccount()}>{busy?'正在登录…':'账号密码登录'}</button><button type="button" disabled={disabled||busy} onClick={()=>{setMode('reset');setMessage('请向桌面最高权限管理员申请一次性密码重置码。')}}>重置密码</button></div>
   </>:mode==='register'?<form className="cloud-registration" onSubmit={event=>void registerAccount(event)}>
    <p className="callout">提交后由桌面最高权限审核。手机号为唯一登记信息，真实姓名必填，昵称选填；请填写身份说明并选择申请维护的题库。</p>
    <label>账号<input required minLength={4} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,30}[A-Za-z0-9]" autoComplete="username" spellCheck={false} value={username} disabled={disabled||busy} onChange={e=>setUsername(e.target.value)} placeholder="4–32 位字母、数字、点、下划线或连字符"/></label>
    <label>手机号<input required type="tel" inputMode="tel" autoComplete="tel" value={phone} disabled={disabled||busy} onChange={e=>setPhone(e.target.value)} placeholder="中国大陆 11 位手机号"/></label>
    <label>真实姓名<input required maxLength={40} autoComplete="name" value={realName} disabled={disabled||busy} onChange={e=>setRealName(e.target.value)}/></label>
    <label>昵称（选填）<input maxLength={80} value={nickname} disabled={disabled||busy} onChange={e=>setNickname(e.target.value)}/></label>
    <label>身份说明<textarea required minLength={1} maxLength={500} rows={3} value={identityDescription} disabled={disabled||busy} onChange={e=>setIdentityDescription(e.target.value)} placeholder="说明你与所申请题库的关系及维护用途"/></label>
    <fieldset className="cloud-bank-picker" disabled={disabled||busy||banksLoading}>
     <legend>申请维护的题库</legend>
     {banksLoading?<p>正在读取云端题库…</p>:banks.length?banks.map(bank=><label key={bank.bank_id}><input type="checkbox" checked={selectedBanks.includes(bank.bank_id)} onChange={event=>setSelectedBanks(current=>event.target.checked?[...current,bank.bank_id]:current.filter(id=>id!==bank.bank_id))}/>{bank.name}</label>):<p>暂无可申请题库。<button type="button" disabled={busy} onClick={()=>void loadBanks()}>重新获取</button></p>}
    </fieldset>
    <label>设置密码<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} disabled={disabled||busy} onChange={e=>setPassword(e.target.value)} placeholder="至少 8 位，含大小写字母和数字"/><small>至少 8 位，且包含大写字母、小写字母和数字。</small></label>
    <label>确认密码<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmPassword} disabled={disabled||busy} onChange={e=>setConfirmPassword(e.target.value)}/>{confirmPassword&&confirmPassword!==password&&<small className="warning">两次输入的密码不一致。</small>}</label>
    <div className="cloud-login-actions"><button className="primary" type="submit" disabled={disabled||busy||banksLoading||!banks.length||!selectedBanks.length||!registrationPasswordReady}>{busy?'正在提交…':'提交注册申请'}</button><button type="button" disabled={disabled||busy||banksLoading} onClick={()=>void loadBanks()}>刷新题库</button></div>
   </form>:<form className="cloud-registration" onSubmit={event=>void resetAccountPassword(event)}>
    <p className="callout">一次性重置码由桌面最高权限管理员生成并转交。密码重置后，题库上传权限需要重新审批。</p>
    <label>维护者账号<input required autoComplete="username" spellCheck={false} value={username} disabled={disabled||busy} onChange={e=>setUsername(e.target.value)}/></label>
    <label>一次性重置码<input required autoComplete="one-time-code" value={resetToken} disabled={disabled||busy} onChange={e=>setResetToken(e.target.value)}/></label>
    <label>新密码<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} disabled={disabled||busy} onChange={e=>setNewPassword(e.target.value)} placeholder="至少 8 位，含大小写字母和数字"/><small>至少 8 位，且包含大写字母、小写字母和数字。</small></label>
    <div className="cloud-login-actions"><button className="primary" type="submit" disabled={disabled||busy||!username||!resetToken||!passwordMeetsPolicy(newPassword)}>{busy?'正在重置…':'重置密码'}</button><button type="button" disabled={disabled||busy} onClick={()=>setMode('account')}>返回登录</button></div>
   </form>}</div>
  </>}
  {remembersMachine()&&<div className="cloud-machine-credentials" role="group" aria-label="本机凭据">
   <div className="cloud-machine-copy"><strong>本机凭据</strong><span>已保存在系统凭据管理器</span></div>
   <div className="cloud-machine-actions">
    <button className="primary" type="button" disabled={disabled||busy} onClick={()=>{void resumeDesktop().then(()=>{render(n=>n+1);onChange()}).catch(e=>setMessage(String(e)))}}>使用本机凭据登录</button>
    <button className="cloud-remove-credential" type="button" disabled={disabled||busy} onClick={()=>{void cloudForget().then(()=>{setRemember(false);render(n=>n+1)}).catch(e=>setMessage(String(e)))}}>移除本机凭据</button>
   </div>
  </div>}
  {message&&<p role="status">{message}</p>}
  <details className="cloud-server-settings"><summary>云端服务器地址</summary><div className="cloud-server-fields">
   <label>云端 HTTPS 地址<input value={origin} disabled={disabled||busy} onChange={e=>setOrigin(e.target.value)}/></label>
   <p className="cloud-address-hint">服务地址必须使用 HTTPS，且服务器证书需要受系统信任。</p>
   <button type="button" disabled={disabled||busy||!origin} onClick={saveOrigin}>保存服务地址</button>
  </div></details>
 </div>;
}
