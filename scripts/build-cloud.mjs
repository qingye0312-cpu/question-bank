import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'cloud/qbank-auth');
const output = path.join(root, 'artifacts/cloud/qbank-auth');
const require = createRequire(path.join(source, 'package.json'));
const sdk = path.dirname(require.resolve('cos-nodejs-sdk-v5/package.json'));
await fs.mkdir(output, { recursive: true });
for (const name of ['index.js', 'service.cjs', 'adapters.cjs', 'package.json'])
  await fs.copyFile(path.join(source, name), path.join(output, name));
await fs.writeFile(path.join(output, 'intake.cjs'), ts.transpileModule(await fs.readFile(path.join(root, 'shared/intake.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText);

// Flatten the exact production dependency graph. No symlinks pointing outside the deploy ZIP.
const installed = new Map();
async function packageDirectory(localRequire, name) {
  for (const base of localRequire.resolve.paths(`${name}/`) || []) {
    const directory = path.join(base, name);
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name === name) return await fs.realpath(directory);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`无法定位依赖：${name}`);
}
async function copyDependency(directory) {
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  if (installed.has(pkg.name)) {
    if (installed.get(pkg.name) !== pkg.version) throw new Error(`依赖版本冲突：${pkg.name}`);
    return;
  }
  installed.set(pkg.name, pkg.version);
  await fs.cp(directory, path.join(output, 'node_modules', pkg.name), {
    recursive: true, dereference: true,
    filter: filename => !filename.slice(directory.length).split(path.sep).includes('node_modules'),
  });
  const localRequire = createRequire(path.join(directory, 'package.json'));
  for (const dependency of Object.keys(pkg.dependencies || {}))
    await copyDependency(await packageDirectory(localRequire, dependency));
}
// This directory is generated and ignored. Rebuilding removes stale dependencies from an earlier SDK.
await fs.rm(path.join(output, 'node_modules'), { recursive: true, force: true });
await copyDependency(sdk);
const zip = path.join(root, 'artifacts/cloud/qbank-auth-0.2.7.zip');
await fs.rm(zip, { force: true });
const result = spawnSync('zip', ['-q', '-r', zip, 'index.js', 'service.cjs', 'adapters.cjs', 'intake.cjs', 'package.json', 'node_modules'], {
  cwd: output, encoding: 'utf8',
});
if (result.status !== 0) throw new Error(result.stderr || '请安装 zip 命令后重新构建');
console.log(`云函数已打包（${installed.size} 个固定版本依赖）：${zip}`);
