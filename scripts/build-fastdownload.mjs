import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'tools/self-host/fastdownload-server');
const page = path.join(root, 'tools/self-host/fastdownload-page/index.html');
const output = path.join(root, 'artifacts/self-host/qbank-fastdownload');
const archive = path.join(root, 'artifacts/self-host/qbank-fastdownload-0.1.0.tar.gz');

for (const required of ['node_modules/werift', 'node_modules/@noble/hashes']) {
  try { await fs.access(path.join(source, required)); }
  catch { throw new Error(`缺少 ${required}；请在 ${source} 执行 pnpm install --ignore-workspace`); }
}

const pnpmStore = path.join(root, 'node_modules/.pnpm');
const entries = await fs.readdir(pnpmStore);
const esbuildEntry = entries.find(name => name.startsWith('esbuild@'));
if (!esbuildEntry) throw new Error('缺少 esbuild，无法打包浏览器 SHA-256 worker');
const esbuild = path.join(pnpmStore, esbuildEntry, 'node_modules/esbuild/bin/esbuild');
await fs.access(esbuild);

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(path.join(output, 'site/fastdowmload'), { recursive: true });
await fs.cp(source, path.join(output, 'server'), {
  recursive: true,
  verbatimSymlinks: true,
  filter: sourcePath => {
    const relative = path.relative(source, sourcePath);
    return relative !== 'test' && !relative.startsWith(`test${path.sep}`);
  },
});
await fs.copyFile(page, path.join(output, 'site/fastdowmload/index.html'));
await fs.mkdir(path.join(output, 'service'), { recursive: true });
await fs.copyFile(path.join(root, 'tools/self-host/qbank-fastdownload.initd'), path.join(output, 'service/qbank-fastdownload.initd'));

const bundle = spawnSync(esbuild, [
  path.join(source, 'hash-worker.mjs'),
  '--bundle',
  '--platform=browser',
  '--format=iife',
  '--target=es2020',
  `--outfile=${path.join(output, 'site/fastdowmload/sha256-worker.js')}`,
], { encoding: 'utf8' });
if (bundle.status !== 0) throw new Error(bundle.stderr || 'SHA-256 worker 打包失败');

await fs.rm(archive, { force: true });
const packaged = spawnSync('tar', ['-czf', archive, '-C', output, 'server', 'site', 'service'], {
  encoding: 'utf8',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
if (packaged.status !== 0) throw new Error(packaged.stderr || 'fastdownload 服务打包失败');
console.log(`实验服务包已生成：${archive}`);
