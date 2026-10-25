import {useState,type FormEvent} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {open} from '@tauri-apps/plugin-dialog';
import {FileKey} from 'lucide-react';
import {cloudAccess,cloudCall,cloudLogin,cloudLoginPassword,cloudLogout,cloudOrigin,setCloudOrigin,fetchCatalog} from '../cloud-client';
import {parseMaintainerCertificate} from './session-service';
import {maintainerPasswordRules,passwordMeetsPolicy} from '../../miniprogram/miniprogram/services/maintainer-password-policy';
import {registrationFields} from '../../miniprogram/miniprogram/services/maintainer-application';

type LoginMode='account'|'register'|'key'|'reset';
type BankChoice={bank_id:string;name:string};
export function CloudLogin({onChange=()=>{},disabled=false}:{onChange?:()=>void;disabled?:boolean}){
 const [origin,setOrigin]=useState(cloudOrigin()),[mode,setMode]=useState<LoginMode>('account');
 const [key,setKey]=useState(''),[password,setPassword]=useState(''),[confirmPassword,setConfirmPassword]=useState('');
 const [phone,setPhone]=useState(''),[realName,setRealName]=useState(''),[nickname,setNickname]=useState(''),[identityDescription,setIdentityDescription]=useState('');
 const [resetToken,setResetToken]=useState(''),[newPassword,setNewPassword]=useState('');
 const [banks,setBanks]=useState<BankChoice[]>([]),[selectedBanks,setSelectedBanks]=useState<string[]>([]),[banksLoading,setBanksLoading]=useState(false);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[,render]=useState(0);
 const access=cloudAccess();
 const registrationPasswordReady=passwordMeetsPolicy(password)&&password===confirmPassword;
 const registrationPasswordChecks=maintainerPasswordRules(password),resetPasswordChecks=maintainerPasswordRules(newPassword);

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
  try{if(origin!==cloudOrigin())setCloudOrigin(origin);await cloudLogin(secret);setMessage('最高权限登录成功；登录状态已安全保存在本机，退出登录后会清除。');render(n=>n+1);onChange();}
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
   await cloudLogin(cert.key);
   setMessage(`最高权限证书登录成功：${cert.certificate_id}；登录状态已安全保存在本机，退出登录后会清除。`);
   render(n=>n+1);onChange();
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function loginAccount(){
  if(busy)return;setBusy(true);setMessage('');const secret=password;setPassword('');
  try{if(origin!==cloudOrigin())setCloudOrigin(origin);const result=await cloudLoginPassword(phone,secret);
   const status=result.account_status==='approved'?'已获桌面管理员授权':result.account_status==='rejected'?'申请未通过，可重新申请':'等待桌面管理员审批';
   setMessage(`手机号登录成功，${status}；登录状态会一直保留到退出登录。`);render(n=>n+1);onChange();
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function registerAccount(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;
  let fields:ReturnType<typeof registrationFields>;
  try{fields=registrationFields({phone,realName,nickname,identity:identityDescription,password,passwordConfirm:confirmPassword});}
  catch(error){setMessage(error instanceof Error?error.message:'注册信息无效');return;}
  if(!selectedBanks.length){setMessage('至少选择一个申请维护的题库。');return;}
  setBusy(true);setMessage('');
  try{
   if(origin!==cloudOrigin())setCloudOrigin(origin);
   await cloudCall('/v1/auth/register',{...fields,bank_ids:selectedBanks});
   setPassword('');setConfirmPassword('');setMode('account');
   setMessage('申请已提交，等待桌面最高权限审批。审批通过后，此账号才可上传所选题库。');
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 async function resetAccountPassword(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;
  if(!passwordMeetsPolicy(newPassword)){setMessage('密码需为 8–128 个字符，包含大写字母、小写字母和数字，且 UTF-8 不超过 512 字节。');return;}
  setBusy(true);setMessage('');
  try{
   if(origin!==cloudOrigin())setCloudOrigin(origin);
   await cloudCall('/v1/auth/password-reset',{phone:phone.trim(),reset_token:resetToken.trim(),password:newPassword});
   setPassword('');setNewPassword('');setResetToken('');setMode('account');
   setMessage('密码已重置。请重新登录，并等待桌面最高权限再次批准题库权限。');
  }catch(e){setMessage(String(e));}finally{setBusy(false);}
 }
 const statusLabel=access?.account_status==='approved'?'已授权':access?.account_status==='pending'?'等待管理员审批':access?.account_status==='rejected'?'申请未通过':access?.account_status==='password_reset_required'?'等待重置密码':access?.account_status==='desktop'?'最高权限':'';
 return <div className="cloud-access"><div className="cloud-access-heading"><h3>云端登录与权限</h3><span>{access?'已登录':'选择登录方式'}</span></div><p>日常搜题与本地录题无需登录。维护者账号需由桌面最高权限审批后，才能上传获批题库；手机号用于唯一登记，当前不发送短信验证码。</p>
  {access?<div className="cloud-session-info"><p>当前身份：{access.auth_type==='password'?`手机号 ${access.phone||''}`:access.auth_type==='key'?'最高权限（密钥／证书）':'维护者'}{statusLabel?` · ${statusLabel}`:''}</p><p>已授权题库：{access.banks.map(b=>b.name).join('、')||'暂无'}</p><div className="cloud-login-actions"><button type="button" disabled={disabled||busy} onClick={()=>{void cloudLogout().then(()=>{setMode('account');setMessage('已退出登录，本机登录凭据已清除。');render(n=>n+1);onChange();}).catch(e=>setMessage(String(e)))}}>退出登录</button></div></div>:<>
   <div className="cloud-login-mode" role="group" aria-label="登录方式">
    <button type="button" aria-pressed={mode==='account'||mode==='reset'} disabled={disabled||busy} onClick={()=>{setMode('account');setMessage('');}}>登录</button>
    <button type="button" aria-pressed={mode==='register'} disabled={disabled||busy} onClick={openRegistration}>注册</button>
    <button type="button" aria-pressed={mode==='key'} disabled={disabled||busy} onClick={()=>{setMode('key');setMessage('');}}>最高权限</button>
   </div>
   <div className="cloud-login-panel">{mode==='key'?<>
    <p className="cloud-login-hint">最高权限密钥和分发证书等效，任选一种即可登录。两种方式使用同一最高权限身份。</p>
    <p className="cloud-login-hint">登录状态会保留在本机，点击“退出登录”后清除。</p>
    <label>最高权限密钥<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={disabled||busy} onChange={e=>setKey(e.target.value)}/></label>
    <div className="cloud-login-actions"><button type="button" disabled={disabled||busy||!key} onClick={()=>void loginKey()}>{busy?'正在验证…':'使用密钥登录'}</button><button type="button" disabled={disabled||busy} onClick={()=>void importCertificate()}><FileKey size={16}/>导入证书并登录</button></div>
   </>:mode==='account'?<>
    <label>手机号<input type="tel" inputMode="tel" autoComplete="tel" value={phone} disabled={disabled||busy} onChange={e=>setPhone(e.target.value)} placeholder="中国大陆 11 位手机号"/></label>
    <label>密码<input type="password" autoComplete="current-password" value={password} disabled={disabled||busy} onChange={e=>setPassword(e.target.value)}/></label>
    <div className="cloud-login-actions cloud-account-actions"><button className="primary" type="button" disabled={disabled||busy||!phone||!password} onClick={()=>void loginAccount()}>{busy?'正在登录…':'手机号和密码登录'}</button><button type="button" disabled={disabled||busy} onClick={()=>{setMode('reset');setMessage('请向桌面最高权限管理员申请一次性密码重置码。')}}>重置密码</button></div>
   </>:mode==='register'?<form className="cloud-registration" onSubmit={event=>void registerAccount(event)}>
   <p className="callout">提交后由桌面最高权限审核。手机号为唯一登记信息，真实姓名必填，昵称选填；请填写身份说明并选择申请维护的题库。</p>
    <label>手机号<input required type="tel" inputMode="tel" autoComplete="tel" value={phone} disabled={disabled||busy} onChange={e=>setPhone(e.target.value)} placeholder="中国大陆 11 位手机号"/></label>
    <label>真实姓名<input required maxLength={40} autoComplete="name" value={realName} disabled={disabled||busy} onChange={e=>setRealName(e.target.value)}/></label>
    <label>昵称（选填）<input maxLength={80} value={nickname} disabled={disabled||busy} onChange={e=>setNickname(e.target.value)}/></label>
    <label>身份说明<textarea required minLength={1} maxLength={500} rows={3} value={identityDescription} disabled={disabled||busy} onChange={e=>setIdentityDescription(e.target.value)} placeholder="说明你与所申请题库的关系及维护用途"/></label>
    <fieldset className="cloud-bank-picker" disabled={disabled||busy||banksLoading}>
     <legend>申请维护的题库</legend>
     {banksLoading?<p>正在读取云端题库…</p>:banks.length?banks.map(bank=><label key={bank.bank_id}><input type="checkbox" checked={selectedBanks.includes(bank.bank_id)} onChange={event=>setSelectedBanks(current=>event.target.checked?[...current,bank.bank_id]:current.filter(id=>id!==bank.bank_id))}/>{bank.name}</label>):<p>暂无可申请题库。<button type="button" disabled={busy} onClick={()=>void loadBanks()}>重新获取</button></p>}
    </fieldset>
    <label>设置密码<input required type="password" autoComplete="new-password" minLength={8} value={password} disabled={disabled||busy} onChange={e=>setPassword(e.target.value)} placeholder="8–128 个字符，含大小写字母和数字"/>
     <span className="password-rules">{registrationPasswordChecks.map(rule=><small className={rule.valid?'valid':'invalid'} key={rule.key}>{rule.valid?'✓':'○'} {rule.label}</small>)}</span></label>
    <label>确认密码<input required type="password" autoComplete="new-password" minLength={8} value={confirmPassword} disabled={disabled||busy} onChange={e=>setConfirmPassword(e.target.value)}/>{confirmPassword&&<small className={confirmPassword===password?'valid':'invalid'}>{confirmPassword===password?'✓ 密码一致':'○ 两次密码不一致'}</small>}</label>
    <div className="cloud-login-actions"><button className="primary" type="submit" disabled={disabled||busy||banksLoading||!banks.length||!selectedBanks.length||!registrationPasswordReady}>{busy?'正在提交…':'提交注册申请'}</button><button type="button" disabled={disabled||busy||banksLoading} onClick={()=>void loadBanks()}>刷新题库</button></div>
   </form>:<form className="cloud-registration" onSubmit={event=>void resetAccountPassword(event)}>
    <p className="callout">一次性重置码由桌面最高权限管理员生成并转交。密码重置后，题库上传权限需要重新审批。</p>
    <label>手机号<input required type="tel" inputMode="tel" autoComplete="tel" value={phone} disabled={disabled||busy} onChange={e=>setPhone(e.target.value)} placeholder="注册时使用的手机号"/></label>
    <label>一次性重置码<input required autoComplete="one-time-code" value={resetToken} disabled={disabled||busy} onChange={e=>setResetToken(e.target.value)}/></label>
    <label>新密码<input required type="password" autoComplete="new-password" minLength={8} value={newPassword} disabled={disabled||busy} onChange={e=>setNewPassword(e.target.value)} placeholder="8–128 个字符，含大小写字母和数字"/>
     <span className="password-rules">{resetPasswordChecks.map(rule=><small className={rule.valid?'valid':'invalid'} key={rule.key}>{rule.valid?'✓':'○'} {rule.label}</small>)}</span></label>
    <div className="cloud-login-actions"><button className="primary" type="submit" disabled={disabled||busy||!phone||!resetToken||!passwordMeetsPolicy(newPassword)}>{busy?'正在重置…':'重置密码'}</button><button type="button" disabled={disabled||busy} onClick={()=>setMode('account')}>返回登录</button></div>
   </form>}</div>
  </>}
  {message&&<p role="status">{message}</p>}
  <details className="cloud-server-settings"><summary>云端服务器地址</summary><div className="cloud-server-fields">
   <label>云端 HTTPS 地址<input value={origin} disabled={disabled||busy} onChange={e=>setOrigin(e.target.value)}/></label>
   <p className="cloud-address-hint">服务地址必须使用 HTTPS，且服务器证书需要受系统信任。</p>
   <button type="button" disabled={disabled||busy||!origin} onClick={saveOrigin}>保存服务地址</button>
  </div></details>
 </div>;
}
