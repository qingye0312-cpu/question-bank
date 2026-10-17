import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const root = new URL('../', import.meta.url);
const result = await build({configFile:false, logLevel:'silent', build:{write:false, target:'es2020',
  lib:{entry:fileURLToPath(new URL('shared/gzip.ts', root)), formats:['cjs'], fileName:()=> 'gzip.js'},
  minify:'esbuild', sourcemap:false}});
const output = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk');
const version = JSON.parse(await readFile(new URL('node_modules/fflate/package.json', root), 'utf8')).version;
const files = new Map([
  ['miniprogram/miniprogram/vendor/gzip.js', `// Generated from fflate ${version}; MIT license in fflate.LICENSE.txt.\n${output.code}`],
  ['miniprogram/miniprogram/vendor/fflate.LICENSE.txt', await readFile(new URL('node_modules/fflate/LICENSE', root), 'utf8')],
]);
for (const [name, content] of files) {
  const file = new URL(name, root);
  if (process.argv.includes('--check')) {
    if (await readFile(file, 'utf8').catch(()=>null) !== content) throw new Error(`${name} 需要重新运行 node scripts/build-miniprogram-vendor.mjs`);
  } else { await mkdir(new URL('.', file), {recursive:true}); await writeFile(file, content); }
}
