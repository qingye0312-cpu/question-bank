import {readFile, mkdir, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = resolve(root, 'miniprogram/miniprogram/data');
const embeddedFiles = ['compact.br', 'questions.json', 'manifest.json', 'manifest.ts', 'index.json', 'bundle-manifest.json', 'bundle-index.json'];

/**
 * The Mini Program is cloud-only. The publishing sources stay under
 * tools/mobile-index/sources for desktop and server release work, but no
 * question bundle is copied into the WeChat code package.
 */
export async function prepareCloudOnly({check = false} = {}) {
  const existing = [];
  for (const name of embeddedFiles) {
    try { await readFile(resolve(destination, name)); existing.push(name); } catch { /* already absent */ }
  }
  if (check) {
    if (existing.length) throw new Error(`小程序仍包含内置题库资源：${existing.join(', ')}`);
    return {mode: 'cloud-only', embeddedFiles: 0, source: 'remote-qbank-auth'};
  }
  await mkdir(destination, {recursive: true});
  for (const name of embeddedFiles) await rm(resolve(destination, name), {force: true});
  return {mode: 'cloud-only', embeddedFiles: 0, source: 'remote-qbank-auth'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--cloud-only')) throw new Error('小程序已改为云端题库模式，不能再生成内置题库；请使用 --cloud-only');
  console.log(JSON.stringify(await prepareCloudOnly({check: args.includes('--check')}), null, 2));
}
