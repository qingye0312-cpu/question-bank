import {LocalBank, SearchIndex, buildPostingsFromLines} from '../core/search';

export type Manifest = {
  schema_version: string; bank_id: string; name: string; release_id: string;
  release_version: number; question_count: number;
};
export type BankBundle = {bank: LocalBank; manifest: Manifest};
let pending: Promise<BankBundle> | undefined;
export const startupMetrics = {source: '', readMs: 0, indexMs: 0, saveMs: 0, totalMs: 0, cacheSaved: false};

function readText(path: string): Promise<string> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: path, encoding: 'utf8', success: result => resolve(result.data as string),
    fail: error => reject(new Error(error.errMsg)),
  }));
}

// Accidental corruption detection, not a publishing/security signature.
function checksum(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0;
}

async function loadEmbedded(): Promise<BankBundle> {
  const started = Date.now();
  const [manifestText, questionText] = await Promise.all([readText('data/manifest.json'), readText('data/questions.json')]);
  const manifest = JSON.parse(manifestText) as Manifest;
  const embedded = JSON.parse(questionText) as {format?: string; payload?: unknown} | null;
  if (manifest.schema_version !== '1.0' || !/^[a-f0-9]{64}$/.test(manifest.release_id)
      || embedded?.format !== 'qbank-embedded-jsonl-1' || typeof embedded.payload !== 'string') {
    throw new Error('内置题库资源格式无效，请重新编译');
  }
  const lines = embedded.payload.trimEnd().split('\n');
  if (lines.length !== manifest.question_count) throw new Error('内置题库数量不一致，请重新编译');
  startupMetrics.readMs = Date.now() - started;
  const indexStarted = Date.now();
  const cache = `${wx.env.USER_DATA_PATH}/qbank-runtime-index-v1.json`;
  let index: SearchIndex | undefined;
  startupMetrics.cacheSaved = false;
  try {
    const wrapper = JSON.parse(await readText(cache)) as {payload: string; checksum: number};
    if (typeof wrapper.payload !== 'string' || checksum(wrapper.payload) !== wrapper.checksum) throw new Error('cache checksum');
    const value = JSON.parse(wrapper.payload) as SearchIndex;
    if (value.schema_version !== 'qbank-index-1' || value.release_id !== manifest.release_id
        || value.question_count !== lines.length || !value.postings || typeof value.postings !== 'object'
        || !Object.values(value.postings).every(p => typeof p === 'string' && /^[0-9a-z]+(?:\.[0-9a-z]+)*$/.test(p))) throw new Error('stale cache');
    index = value;
    startupMetrics.source = 'cache';
    startupMetrics.cacheSaved = true;
  } catch { /* Missing, corrupt, or previous release: rebuild from bundled questions. */ }
  if (!index) {
    index = {schema_version: 'qbank-index-1', release_id: manifest.release_id,
      question_count: lines.length, postings: await buildPostingsFromLines(lines)};
    startupMetrics.source = 'generated';
  }
  startupMetrics.indexMs = Date.now() - indexStarted;
  const saveStarted = Date.now();
  if (!startupMetrics.cacheSaved) {
    try {
      const payload = JSON.stringify(index);
      const fs = wx.getFileSystemManager();
      await new Promise<void>((resolve, reject) => fs.writeFile({filePath: cache + '.tmp',
        data: JSON.stringify({payload, checksum: checksum(payload)}), encoding: 'utf8',
        success: () => resolve(), fail: reject}));
      await new Promise<void>((resolve, reject) => fs.rename({oldPath: cache + '.tmp', newPath: cache,
        success: () => resolve(), fail: reject}));
      startupMetrics.cacheSaved = true;
    } catch { console.warn('[qbank] 索引缓存写入失败，本次仍可搜索，下次启动会重新生成'); }
  }
  startupMetrics.saveMs = Date.now() - saveStarted;
  startupMetrics.totalMs = Date.now() - started;
  console.info('[qbank startup]', JSON.stringify(startupMetrics));
  return {manifest, bank: new LocalBank(lines, index)};
}

export function loadBank(): Promise<BankBundle> {
  if (!pending) pending = loadEmbedded().catch(error => { pending = undefined; throw error; });
  return pending;
}
