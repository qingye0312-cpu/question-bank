import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { parseDelta } from '../../shared/intake.ts';

export function encodeUpload(text) {
  const { questions } = parseDelta(text);
  const raw = Buffer.from(text), compressed = gzipSync(raw);
  if (questions.length > 100 || raw.length > 4 * 1024 * 1024 || compressed.length > 512 * 1024)
    throw new Error('每包最多 100 题，压缩前最多 4 MiB，压缩后最多 512 KiB');
  return { format: 'qbank-upload-1', encoding: 'gzip+base64', uncompressed_size: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'), data: compressed.toString('base64') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('用法：node tools/cloud/encode-upload.mjs 输入.qbank-delta.json 输出.qbank-upload.json');
  await writeFile(output, JSON.stringify(encodeUpload(await readFile(input, 'utf8'))), { flag: 'wx', mode: 0o600 });
  console.log(`已生成压缩上传包：${output}`);
}
