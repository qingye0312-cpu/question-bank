import fs from 'node:fs/promises';
import path from 'node:path';

const [version, artifactDir, manifestPath] = process.argv.slice(2);
if (!version || !artifactDir || !manifestPath || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Usage: node create-manifest.mjs <version> <artifact-directory> <manifest-path>');
}

const macName = `qbank-${version}-macos-arm64-app.tar.gz`;
const windowsName = `qbank-${version}-windows-x64-nsis.zip`;
const artifactRoot = path.resolve(artifactDir);
async function readSignature(name) {
  const signature = (await fs.readFile(path.join(artifactRoot, `${name}.sig`), 'utf8')).trim();
  if (!signature) throw new Error(`Empty updater signature: ${name}.sig`);
  await fs.access(path.join(artifactRoot, name));
  return signature;
}

const [macSignature, windowsSignature] = await Promise.all([
  readSignature(macName),
  readSignature(windowsName),
]);
const base = 'https://qbank.acharrystar.top:8013/v1/desktop/releases';
const manifest = {
  version,
  notes: `题库 ${version} 桌面版更新。Windows 便携版用于手动下载；自动更新请安装 NSIS 安装版。`,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      signature: macSignature,
      url: `${base}/${macName}`,
    },
    'windows-x86_64': {
      signature: windowsSignature,
      url: `${base}/windows/${version}/${windowsName}`,
    },
  },
};
const output = path.resolve(manifestPath);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
