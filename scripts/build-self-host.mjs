import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'cloud/qbank-auth');
const output = path.join(root, 'artifacts/self-host/qbank-auth');
const files = ['service.cjs', 'workflow.cjs', 'codec.cjs', 'catalog.cjs', 'common.cjs', 'access.cjs', 'password.cjs',
  'config.cjs', 'auth.cjs', 'submission.cjs', 'projection.cjs', 'wechat-login.cjs', 'fs-store.cjs', 'local-server.cjs', 'intake.cjs', 'seed-bank.cjs','repair-bank-status.cjs'];

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const name of files) {
  const from = name === 'intake.cjs' ? null
    : ['seed-bank.cjs','repair-bank-status.cjs'].includes(name) ? path.join(root, 'tools/self-host', name) : path.join(source, name);
  if (name === 'intake.cjs') {
    const sourceText = await fs.readFile(path.join(root, 'shared/intake.ts'), 'utf8');
    await fs.writeFile(path.join(output, name), ts.transpileModule(sourceText, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText);
    continue;
  }
  try { await fs.copyFile(from, path.join(output, name)); }
  catch (error) { throw error; }
}
await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({
  name: 'qbank-auth-self-host', version: '0.2.7', private: true, type: 'commonjs',
  engines: { node: '>=20' }, scripts: { start: 'node local-server.cjs' },
}, null, 2) + '\n');
const archive = path.join(root, 'artifacts/self-host/qbank-auth-0.2.7.tar.gz');
await fs.rm(archive, { force: true });
const result = spawnSync('tar', ['-czf', archive, '-C', output, ...files, 'package.json'], { encoding: 'utf8', env:{...process.env,COPYFILE_DISABLE:'1'} });
if (result.status !== 0) throw new Error(result.stderr || '请安装 tar 命令后重新构建');
console.log(`自托管服务已打包：${archive}`);
