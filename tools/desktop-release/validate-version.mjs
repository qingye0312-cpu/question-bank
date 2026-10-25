import fs from 'node:fs/promises';

const [tag] = process.argv.slice(2);
const version = tag?.replace(/^v/, '');
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || tag !== `v${version}`) {
  throw new Error('Release tag must be a stable vMAJOR.MINOR.PATCH tag.');
}

const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
const tauri = JSON.parse(await fs.readFile('src-tauri/tauri.conf.json', 'utf8'));
const cargoToml = await fs.readFile('src-tauri/Cargo.toml', 'utf8');
const cargoLock = await fs.readFile('src-tauri/Cargo.lock', 'utf8');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const lockPackage = cargoLock.match(/\[\[package\]\]\s*name = "question-bank"\s*version = "([^"]+)"/);
const lockVersion = lockPackage?.[1];

const versions = {
  packageJson: packageJson.version,
  tauri: tauri.version,
  cargoToml: cargoVersion,
  cargoLock: lockVersion,
};
for (const [source, found] of Object.entries(versions)) {
  if (found !== version) throw new Error(`Release tag ${version} does not match ${source} version ${found ?? '(missing)'}.`);
}
