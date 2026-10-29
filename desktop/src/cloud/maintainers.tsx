import {useEffect,useRef,useState} from 'react';
import {Check,KeyRound,RefreshCw,Shield,X} from 'lucide-react';
import {cloudAccess,cloudCall} from './session-service';
import {hasPermission} from '../../shared/export-permission';

type Application={id:string;auth_type:'password';password_reset?:boolean;password_reset_required?:boolean;phone:string;real_name:string;phone_source:string;nickname:string;identity_description:string;bank_ids:string[];permissions?:string[];created_at:string;status:string};
type Account={id:string;auth_type:'password';phone:string;real_name:string;phone_source:string;nickname:string;identity_description:string;openid:string;grants:Record<string,string[]>;permissions?:string[];status:string;created_at:string;approved_at?:string|null;revoked_at?:string|null};
const MAINTAINER_MANAGEMENT_PERMISSION='maintainer:manage';
type Bank={bank_id:string;name:string};
function sameValues(left:string[],right:string[]){
 const a=[...new Set(left)].sort(),b=[...new Set(right)].sort();
 return a.length===b.length&&a.every((value,index)=>value===b[index]);
}
function requestedPermissions(app:Pick<Application,'bank_ids'|'permissions'>,banks:Bank[]){
 const requested:string[]=[];
 if(app.bank_ids.length)requested.push(`题库维护：${app.bank_ids.map(id=>banks.find(bank=>bank.bank_id===id)?.name||id).join('、')}`);
 for(const permission of app.permissions||[])requested.push(permission==='export'?'Word 导出权限：全部题库':permission===MAINTAINER_MANAGEMENT_PERMISSION?'题库维护者管理权限':`其他权限：${permission}`);
 return requested.length?requested.join('；'):'未指定权限';
}
function accountPermissionLabels(account:Account,banks:Bank[]){
 return [
  ...Object.keys(account.grants||{}).filter(id=>hasPermission(account.grants[id],'upload')).map(id=>banks.find(bank=>bank.bank_id===id)?.name||id),
  ...(hasPermission(account.permissions,'export')?['Word 导出（全部题库）']:[]),
  ...(hasPermission(account.permissions,MAINTAINER_MANAGEMENT_PERMISSION)?['题库维护者管理']:[]),
 ];
}
export function MaintainerAdmin({banks,onChange}:{banks:Bank[];onChange?:()=>void}){
 const [applications,setApplications]=useState<Application[]>([]),[accounts,setAccounts]=useState<Account[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[resetCode,setResetCode]=useState('');
 const [editingId,setEditingId]=useState<string|null>(null),[draftBankIds,setDraftBankIds]=useState<string[]>([]),[draftPermissions,setDraftPermissions]=useState<string[]>([]),[maintainerPermissionConfirm,setMaintainerPermissionConfirm]=useState(false);
 const refreshing=useRef(false);
 const access=cloudAccess(),admin=hasPermission(access?.capabilities,MAINTAINER_MANAGEMENT_PERMISSION),canManageMaintainerPermission=access?.auth_type==='key'&&admin;
 async function refresh(){
  if(!admin||refreshing.current)return;
  refreshing.current=true;
  try{
   const [a,b]=await Promise.all([cloudCall<{applications:Application[]}>('/v1/maintainer-applications',undefined,true),cloudCall<{accounts:Account[]}>('/v1/maintainer-accounts',undefined,true)]);
   setApplications(a.applications);setAccounts(b.accounts);
  }finally{refreshing.current=false;}
 }
 useEffect(()=>{
  if(!admin)return;
  let alive=true;
  const report=(error:unknown)=>{if(alive)setMessage(String(error));};
  void refresh().catch(report);
  const timer=window.setInterval(()=>{void refresh().catch(report)},30_000);
  return()=>{alive=false;window.clearInterval(timer)};
 },[admin]);
 async function run(fn:()=>Promise<void>){if(busy)return;setBusy(true);setMessage('');try{await fn();onChange?.()}catch(e){setMessage(String(e))}finally{setBusy(false)}}
 async function decide(app:Application,decision:'approve'|'reject'){await run(async()=>{const grants=Object.fromEntries(app.bank_ids.map(id=>[id,['upload']]));await cloudCall(`/v1/maintainer-applications/${app.id}/decision`,{decision,grants,permissions:app.permissions||[],note:decision==='approve'?'维护者管理权限批准':'维护者管理权限拒绝'},true);await refresh()})}
 async function revoke(account:Account){if(!window.confirm(`撤销手机号 ${account.phone} 的维护者权限？`))return;await run(async()=>{await cloudCall(`/v1/maintainer-accounts/${account.id}/revoke`,{},true);await refresh()})}
 async function resetPassword(account:Pick<Account,'id'|'phone'>){
  if(!window.confirm(`为手机号 ${account.phone} 重置密码？这会立即清除现有题库授权和 Word 导出权限。用户设置新密码后，仍需桌面管理员重新审批。`))return;
  await run(async()=>{const result=await cloudCall<{reset_token:string;expires_at:string}>(`/v1/maintainer-accounts/${account.id}/password-reset`,{},true);if(typeof result.reset_token!=='string'||!result.reset_token)throw Error('服务器没有返回重置码');setResetCode(result.reset_token);await refresh();setMessage(`已生成 24 小时有效的一次性重置码，请安全转交账号本人：`);});
 }
 function openPermissions(account:Account){
  setEditingId(account.id);
  setDraftBankIds(Object.keys(account.grants||{}).filter(id=>hasPermission(account.grants[id],'upload')));
  setDraftPermissions((account.permissions||[]).filter(permission=>permission==='export'||(permission===MAINTAINER_MANAGEMENT_PERMISSION&&canManageMaintainerPermission)));
  setMaintainerPermissionConfirm(false);
  setResetCode('');setMessage('');
 }
 const editingAccount=accounts.find(account=>account.id===editingId)||null;
 const originalBankIds=editingAccount?Object.keys(editingAccount.grants||{}).filter(id=>hasPermission(editingAccount.grants[id],'upload')):[];
 const originalPermissions=editingAccount?(editingAccount.permissions||[]).filter(permission=>permission==='export'||(permission===MAINTAINER_MANAGEMENT_PERMISSION&&canManageMaintainerPermission)):[];
 const permissionsChanged=!!editingAccount&&(!sameValues(draftBankIds,originalBankIds)||!sameValues(draftPermissions,originalPermissions));
 function leavePermissions(){
  if(busy)return;
  if(permissionsChanged&&!window.confirm('放弃尚未保存的权限修改？'))return;
  setMaintainerPermissionConfirm(false);setEditingId(null);setMessage('');
 }
 async function savePermissions(){
  const account=editingAccount;if(!account||!permissionsChanged)return;
  await run(async()=>{
   await cloudCall(`/v1/maintainer-accounts/${account.id}/permissions`,{bank_ids:draftBankIds,permissions:draftPermissions},true);
   await refresh();setMaintainerPermissionConfirm(false);setEditingId(null);setMessage('权限已更新');
  });
 }
 const approvedAccounts=accounts.filter(a=>a.status==='approved'),pendingAccounts=accounts.filter(a=>a.status!=='approved'&&a.status!=='revoked');
 return <section className="maintainer-admin" aria-label="权限管理"><div className="maintainer-toolbar"><button disabled={busy||!admin} onClick={()=>void run(refresh)}><RefreshCw size={16}/>刷新申请</button><p className="callout maintainer-guidance">手机号是唯一登录标识，真实姓名、昵称和身份说明由申请人填写；请核实后批准。已授权账号的真实姓名可以进入权限管理，修改题库维护和 Word 导出权限。</p></div>
  {!admin?<p className="callout"><Shield size={16}/>请先登录具备题库维护者管理权限的账号，再查看和处理维护者申请。</p>:editingAccount?<section className="maintainer-permission-editor" aria-label={`${editingAccount.real_name}的权限管理`}>
   <div className="maintainer-editor-heading"><div><h3>权限管理</h3><p>{editingAccount.real_name} · {editingAccount.phone}</p><p className="maintainer-editor-identity"><strong>身份说明：</strong>{editingAccount.identity_description||'未填写'}</p></div><span>{editingAccount.nickname||'未填写昵称'}</span></div>
   <fieldset className="maintainer-permission-fieldset"><legend>题库维护权限</legend>{banks.length?banks.map(bank=>{const checked=draftBankIds.includes(bank.bank_id);return <label key={bank.bank_id}><input type="checkbox" checked={checked} disabled={busy} onChange={event=>{const nextChecked=event.currentTarget.checked;setDraftBankIds(current=>nextChecked?[...new Set([...current,bank.bank_id])]:current.filter(id=>id!==bank.bank_id))}}/><span>{bank.name}</span></label>}):<p className="maintainer-empty">当前没有可授权的云端题库。</p>}</fieldset>
   <fieldset className="maintainer-permission-fieldset">
    <legend>全局权限</legend>
    <label><input type="checkbox" checked={draftPermissions.includes('export')} disabled={busy} onChange={event=>{const nextChecked=event.currentTarget.checked;setDraftPermissions(current=>nextChecked?[...new Set([...current,'export'])]:current.filter(permission=>permission!=='export'))}}/><span>Word 导出（全部题库）</span></label>
    {canManageMaintainerPermission&&<label><input type="checkbox" checked={draftPermissions.includes(MAINTAINER_MANAGEMENT_PERMISSION)} disabled={busy} onChange={event=>{const nextChecked=event.currentTarget.checked;if(nextChecked){setMaintainerPermissionConfirm(true);return;}setDraftPermissions(current=>current.filter(permission=>permission!==MAINTAINER_MANAGEMENT_PERMISSION));}}/><span>题库维护者管理</span></label>}
   </fieldset>
   <div className="maintainer-editor-actions"><button type="button" disabled={busy} onClick={leavePermissions}>返回账号列表</button>{permissionsChanged&&<button type="button" disabled={busy} onClick={()=>void savePermissions()}>确认修改</button>}</div>
   {!permissionsChanged&&<p className="maintainer-editor-hint">修改权限后会显示“确认修改”按钮。</p>}
  </section>:<>
  <div className="maintainer-section-heading"><h3>待审批申请 · {applications.length}</h3>{applications.length===0&&<p className="maintainer-empty">暂无待审批申请。</p>}</div>{applications.map(app=><article className="maintainer-row" key={app.id}><div><b>{app.real_name} · {app.phone}</b><span>{app.nickname||'未填写昵称'}</span><p className="maintainer-requested-permissions"><strong>申请权限</strong><span>{requestedPermissions(app,banks)}</span></p>{app.password_reset&&<small>密码重置后需重新授权</small>}{app.password_reset_required&&<small className="warning">申请人尚未完成密码重置，暂不能处理</small>}<p className="maintainer-identity"><strong>身份说明：</strong>{app.identity_description}</p><small>手机号由申请人填写 · {new Date(app.created_at).toLocaleString()}</small></div><div><button disabled={busy||!!app.password_reset_required} onClick={()=>void decide(app,'approve')}><Check size={15}/>批准</button><button disabled={busy||!!app.password_reset_required} onClick={()=>void decide(app,'reject')}><X size={15}/>拒绝</button></div></article>)}
  <h3>已授权账号 · {approvedAccounts.length}</h3>{approvedAccounts.map(account=><article className="maintainer-row" key={account.id}><div><div className="maintainer-account-heading"><button type="button" className="maintainer-account-name" disabled={busy} onClick={()=>openPermissions(account)}>{account.real_name}</button><span> · {account.phone}</span><small className="maintainer-approved-at">批准于 {account.approved_at?new Date(account.approved_at).toLocaleString():'未知'}</small></div><span>{account.nickname||'未填写昵称'} · 权限：{accountPermissionLabels(account,banks).join('、')||'无'}</span></div><div><button disabled={busy} onClick={()=>void resetPassword(account)}><KeyRound size={15}/>重置密码</button><button disabled={busy} onClick={()=>void revoke(account)}>撤销</button></div></article>)}
  {pendingAccounts.length>0&&<><h3>待授权手机号</h3>{pendingAccounts.map(account=><article className="maintainer-row" key={account.id}><div><b>{account.real_name} · {account.phone}</b><span>{account.status==='password_reset_required'?'等待用户重置密码':account.status==='rejected'?'申请未通过':'等待管理员审批'}</span><p className="maintainer-identity"><strong>身份说明：</strong>{account.identity_description}</p></div><button disabled={busy} onClick={()=>void resetPassword(account)}><KeyRound size={15}/>重置密码</button></article>)}</>}
  </>}
  {maintainerPermissionConfirm&&<div className="maintainer-permission-confirm-layer" onMouseDown={event=>{if(event.target===event.currentTarget)setMaintainerPermissionConfirm(false)}}><section className="maintainer-permission-confirm" role="alertdialog" aria-modal="true" aria-labelledby="maintainer-permission-confirm-title" aria-describedby="maintainer-permission-confirm-copy"><h3 id="maintainer-permission-confirm-title">确认授予维护者管理权限</h3><p id="maintainer-permission-confirm-copy">确认让该账号加入维护者管理权限吗？</p><div className="maintainer-permission-confirm-actions"><button type="button" onClick={()=>setMaintainerPermissionConfirm(false)}>取消</button><button type="button" className="danger" onClick={()=>{setDraftPermissions(current=>[...new Set([...current,MAINTAINER_MANAGEMENT_PERMISSION])]);setMaintainerPermissionConfirm(false)}}>确认</button></div></section></div>}
  {message&&<p className="callout" role="status">{message}{resetCode&&<><br/><code className="maintainer-reset-code">{resetCode}</code><br/><button type="button" onClick={()=>{setResetCode('');setMessage('重置码已从此窗口隐藏；如需重新获取，请重新发放，旧码会失效。')}}>隐藏重置码</button></>}</p>}
 </section>;
}
