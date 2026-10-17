// Generate a high-entropy desktop key locally. Only its digest enters SCF.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const [id,bank,roleList]=process.argv.slice(2);
const roles=(roleList||'').split(',');
if(!/^[A-Za-z0-9_-]{10,64}$/.test(id||'')||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bank||'')||!roles.length||roles.some(r=>!['upload','review','publish'].includes(r))){
 console.error('用法：node tools/cloud/create-maintainer.mjs <10-64位维护者ID> <bank_id> <upload,review,publish中的权限>');process.exit(1);
}
const directory=path.resolve('.local/maintainers');await fs.mkdir(directory,{recursive:true,mode:0o700});
const key=randomBytes(32).toString('hex'),keyPath=path.join(directory,`${id}.key`),configPath=path.join(directory,`${id}.grant.json`);
await fs.writeFile(keyPath,key+'\n',{flag:'wx',mode:0o600});
const grant={id,key_sha256:createHash('sha256').update(key).digest('hex'),grants:{[bank]:[...new Set(roles)]}};
await fs.writeFile(configPath,JSON.stringify(grant,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(`密钥仅保存至：${keyPath}\n授权条目：${configPath}\n将授权条目加入 QBANK_MAINTAINERS 数组；密钥仅在桌面登录时使用，不写入代码或聊天。`);
