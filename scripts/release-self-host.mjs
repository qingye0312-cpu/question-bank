import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const packagePath=path.join(root,'cloud/qbank-auth/package.json');
const packageJson=JSON.parse(await fs.readFile(packagePath,'utf8'));
const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(packageJson.version||'');
if(!match)throw new Error(`无效的自托管服务版本号：${packageJson.version}`);
const nextVersion=`${match[1]}.${match[2]}.${Number(match[3])+1}`;
await fs.writeFile(packagePath,JSON.stringify({...packageJson,version:nextVersion},null,2)+'\n');
const result=spawnSync(process.execPath,[path.join(root,'scripts/build-self-host.mjs')],{cwd:root,stdio:'inherit'});
if(result.status!==0){
  throw new Error(`自托管服务 ${nextVersion} 打包失败，版本号已保留以便修复后重试`);
}
console.log(`自托管服务版本已递增：${packageJson.version} -> ${nextVersion}`);
