import {readFile} from 'node:fs/promises';
import {brotliCompressSync, gzipSync, constants} from 'node:zlib';
import {encodeCompact} from '../../miniprogram/miniprogram/core/compact.ts';

const root = new URL('../../miniprogram/miniprogram/data/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const source = JSON.parse(await readFile(new URL('questions.json', root), 'utf8')).payload;
const questions = source.trimEnd().split('\n').map(JSON.parse);
const br = text => brotliCompressSync(Buffer.from(text), {params: {[constants.BROTLI_PARAM_QUALITY]: 11}});
console.log(JSON.stringify({originalJsonlBytes: Buffer.byteLength(source), fullJsonlBrotliBytes: br(source).length}));
for (const n of [...new Set([100, 250, 500, 750, questions.length].filter(n => n <= questions.length))]) {
  // Even sampling without duplicating records (duplicates inflate predicted compression).
  const sample = questions.filter((_, i) => Math.floor(i * n / questions.length) !== Math.floor((i - 1) * n / questions.length));
  const text = JSON.stringify(encodeCompact(sample, manifest.release_id));
  const bytes = br(text).length;
  console.log(JSON.stringify({questions: sample.length, compactJsonBytes: Buffer.byteLength(text),
    brotliBytes: bytes, gzipBytes: gzipSync(text, {level: 9}).length, bytesPerQuestion: bytes / sample.length}));
}
