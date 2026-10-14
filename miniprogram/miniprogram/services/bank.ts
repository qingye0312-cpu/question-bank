import {LocalBank, SearchIndex} from '../core/search';

export type Manifest = {
  schema_version: string; bank_id: string; name: string; release_id: string;
  release_version: number; question_count: number;
};
export type BankBundle = {bank: LocalBank; manifest: Manifest};
let pending: Promise<BankBundle> | undefined;

function readText(path: string): Promise<string> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: path, encoding: 'utf8',
    success: result => resolve(result.data as string),
    fail: error => {
      console.error('[题库] 内置文件读取失败', path, error.errMsg);
      reject(new Error('内置题库读取失败，请重新编译或重新打开小程序'));
    },
  }));
}

export function loadBank(): Promise<BankBundle> {
  if (!pending) pending = Promise.all([
    readText('data/manifest.json'), readText('data/questions.json'), readText('data/index.json'),
  ]).then(([manifestText, embeddedText, indexText]) => {
    const manifest = JSON.parse(manifestText) as Manifest;
    const index = JSON.parse(indexText) as SearchIndex;
    const embedded = JSON.parse(embeddedText) as {format?: string; payload?: unknown} | null;
    if (embedded?.format !== 'qbank-embedded-jsonl-1' || typeof embedded.payload !== 'string') {
      throw new Error('内置题库资源格式无效，请重新编译');
    }
    if (manifest.schema_version !== '1.0' || index.schema_version !== 'qbank-index-1'
        || index.release_id !== manifest.release_id || index.question_count !== manifest.question_count) {
      throw new Error('内置题库和搜索索引版本不一致，请重新编译');
    }
    // Decode the storage envelope, never re-serialize individual questions.
    const lines = embedded.payload.trimEnd().split('\n');
    return {manifest, bank: new LocalBank(lines, index)};
  }).catch(error => { pending = undefined; throw error; });
  return pending;
}
