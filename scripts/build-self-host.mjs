import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'cloud/qbank-auth');
const generated = path.join(root, 'artifacts/cloud/qbank-auth');
const output = path.join(root, 'artifacts/self-host/qbank-auth');
const files = ['service.cjs', 'workflow.cjs', 'codec.cjs', 'catalog.cjs', 'common.cjs', 'access.cjs',
  'config.cjs', 'auth.cjs', 'submission.cjs', 'projection.cjs', 'adapters.cjs', 'fs-store.cjs', 'local-server.cjs', 'intake.cjs', 'seed-bank.cjs'];

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
for (const name of files) {
  const from = name === 'intake.cjs' ? path.join(generated, name)
    : name === 'seed-bank.cjs' ? path.join(root, 'tools/self-host', name) : path.join(source, name);
  try { await fs.copyFile(from, path.join(output, name)); }
  catch (error) {
    if (name === 'intake.cjs') throw new Error('请先运行 pnpm build:cloud 生成 intake.cjs');
    throw error;
  }
}
await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({
  name: 'qbank-auth-self-host', version: '0.2.7', private: true, type: 'commonjs',
  engines: { node: '>=20' }, scripts: { start: 'node local-server.cjs' },
}, null, 2) + '\n');
const archive = path.join(root, 'artifacts/self-host/qbank-auth-0.2.7.tar.gz');
await fs.rm(archive, { force: true });
const result = spawnSync('tar', ['-czf', archive, '-C', output, ...files, 'package.json'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || '请安装 tar 命令后重新构建');
console.log(`自托管服务已打包：${archive}`);
