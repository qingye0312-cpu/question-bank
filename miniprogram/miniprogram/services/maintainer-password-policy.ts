export type PasswordRule={key:'length'|'uppercase'|'lowercase'|'number'|'bytes';label:string;valid:boolean};

function utf8Bytes(value:string){
 let total=0;
 for(const character of value){const point=character.codePointAt(0)||0;total+=point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;}
 return total;
}

// Shared by the Mini Program and desktop UI so both present exactly the same
// registration and validation rules. The server enforces this same policy.
export function maintainerPasswordRules(value:string):PasswordRule[]{
 const length=Array.from(value).length;
 const bytes=utf8Bytes(value);
 return [
  {key:'length',label:'8–128 个字符',valid:length>=8&&length<=128},
  {key:'uppercase',label:'至少一个大写字母',valid:/[A-Z]/.test(value)},
  {key:'lowercase',label:'至少一个小写字母',valid:/[a-z]/.test(value)},
  {key:'number',label:'至少一个数字',valid:/[0-9]/.test(value)},
  {key:'bytes',label:'UTF-8 不超过 512 字节',valid:bytes<=512},
 ];
}

export function passwordMeetsPolicy(value:string){return maintainerPasswordRules(value).every(rule=>rule.valid)}
