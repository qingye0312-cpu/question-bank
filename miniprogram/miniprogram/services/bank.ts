import {LocalBank, SearchIndex} from '../core/search';

export type Manifest = {
  schema_version: string; bank_id: string; name: string; release_id: string;
  release_version: number; question_count: number;
};
export type BankBundle = {bank: LocalBank; manifest: Manifest};
let pending: Promise<BankBundle> | undefined;
// Loopback development endpoint. Replace with an approved HTTPS domain before release.
const endpoint = 'http://127.0.0.1:8765/bank.json';
const cacheName = 'qbank-download-v1.json';

function readText(path: string): Promise<string> {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: path, encoding: 'utf8',
    success: result => resolve(result.data as string),
    fail: error => {
      reject(new Error(error.errMsg));
    },
  }));
}

function decode(text: string): BankBundle {
    if (text.length > 8 * 1024 * 1024) throw new Error('题库资源过大');
    const files = JSON.parse(text) as unknown;
    if (!Array.isArray(files) || files.length !== 3 || files.some(value => typeof value !== 'string')) throw new Error('题库资源格式无效');
    const [manifestText, embeddedText, indexText] = files as string[];
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
}

async function loadDownloaded(): Promise<BankBundle> {
  const cache = `${wx.env.USER_DATA_PATH}/${cacheName}`;
  try { return decode(await readText(cache)); } catch { /* Missing or invalid cache: download again. */ }
  const temporary = await new Promise<string>((resolve, reject) => wx.downloadFile({
    url: endpoint, timeout: 15000,
    success: result => result.statusCode === 200 ? resolve(result.tempFilePath)
      : reject(new Error(`题库下载失败（HTTP ${result.statusCode}），请重试`)),
    fail: () => reject(new Error('无法下载题库：请启动本地服务器，并检查开发者工具的本地调试网络设置')),
  }));
  const bundle = decode(await readText(temporary));
  const fs = wx.getFileSystemManager();
  await new Promise<void>((resolve, reject) => fs.copyFile({srcPath: temporary, destPath: cache + '.tmp',
    success: () => resolve(), fail: () => reject(new Error('题库缓存写入失败，请检查存储空间后重试'))}));
  await new Promise<void>((resolve, reject) => fs.rename({oldPath: cache + '.tmp', newPath: cache,
    success: () => resolve(), fail: () => reject(new Error('题库缓存保存失败，请重试'))}));
  return bundle;
}

export function loadBank(): Promise<BankBundle> {
  if (!pending) pending = loadDownloaded().catch(error => { pending = undefined; throw error; });
  return pending;
}
