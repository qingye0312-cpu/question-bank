export type MaintainerForm={phone:string;realName:string;nickname:string;identity:string};
export type MaintainerRegistrationForm=MaintainerForm&{password:string;passwordConfirm:string};

export function applicationFields(form:MaintainerForm){
 const phone=form.phone.trim().replace(/[\s()-]/g,'').replace(/^(?:\+86|0086)/,'');
 if(!/^1[3-9]\d{9}$/.test(phone))throw Error('请填写有效的 11 位手机号');
 const real_name=form.realName.trim(),nickname=form.nickname.trim(),identity_description=form.identity.trim();
 if(!real_name||real_name.length>40)throw Error('请填写 1 至 40 字的真实姓名');
 if(nickname.length>80)throw Error('昵称最多 80 字，可以不填');
 if(!identity_description||identity_description.length>500)throw Error('请填写 1 至 500 字的身份说明，方便管理员核实');
 return {phone,real_name,nickname,identity_description};
}

export function registrationFields(form:MaintainerRegistrationForm){
 if(!passwordMeetsPolicy(form.password))throw Error('密码需为 8–128 个字符，包含大写字母、小写字母和数字，且 UTF-8 不超过 512 字节');
 if(form.password!==form.passwordConfirm)throw Error('两次输入的密码不一致');
 return {...applicationFields(form),password:form.password};
}
import {passwordMeetsPolicy} from './maintainer-password-policy';
export {maintainerPasswordRules,passwordMeetsPolicy} from './maintainer-password-policy';
export type {PasswordRule} from './maintainer-password-policy';

