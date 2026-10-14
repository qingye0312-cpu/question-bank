import {createRequire} from 'node:module';
import {mkdir,copyFile,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const tesseract=dirname(require.resolve('tesseract.js/package.json'));
const core=dirname(createRequire(join(tesseract,'package.json')).resolve('tesseract.js-core/package.json'));
await mkdir('public/ocr/core',{recursive:true});
await copyFile(join(tesseract,'dist/worker.min.js'),'public/ocr/worker.min.js');
// The app always uses OEM.LSTM_ONLY. Include all 3 CPU feature variants it can select.
for(const variant of ['lstm','simd-lstm','relaxedsimd-lstm'])for(const ext of ['wasm.js','wasm'])
  await copyFile(join(core,`tesseract-core-${variant}.${ext}`),`public/ocr/core/tesseract-core-${variant}.${ext}`);
await copyFile(join(tesseract,'LICENSE.md'),'assets/ocr/LICENSE-tesseract.js');
await copyFile(join(core,'LICENSE'),'assets/ocr/LICENSE-tesseract-core');
const manifest=JSON.parse(await readFile('assets/ocr/models.json','utf8'));
for(const [name,expected] of Object.entries(manifest.files)){
  const bytes=await readFile(`public/ocr/lang/${name}`);
  if(bytes.length!==expected.bytes||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)
    throw Error(`OCR model checksum mismatch: ${name}`);
}
await mkdir('public/ocr/licenses',{recursive:true});
for(const name of ['LICENSE-tesseract.js','LICENSE-tesseract-core','LICENSE-tessdata','models.json'])
  await copyFile(`assets/ocr/${name}`,`public/ocr/licenses/${name}`);
console.log('OCR worker, WASM engines and pinned Chinese/English models are ready.');
