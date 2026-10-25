import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const releaseDir = path.join(root, 'artifacts/macos', version);
const keyPath = path.join(root, '.local/macos-updater.key');
const passwordPath = path.join(root, '.local/macos-updater.password');
const publicKeyPath = `${keyPath}.pub`;
const endpoint = 'https://qbank.creart.top:8013/v1/desktop/latest.json';
const assetName = `qbank-macos-arm64-${version}.app.tar.gz`;
const assetUrl = `https://qbank.creart.top:8013/v1/desktop/releases/${assetName}`;
const notes = process.env.QBANK_RELEASE_NOTES || `题库 macOS ${version}；启动时自动检查并安装签名更新。`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input: options.input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result;
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function appVersion(appPath) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot read app version: ${appPath}`);
  return result.stdout.trim();
}

async function deploy(bundlePath, signaturePath, manifestPath) {
  const installScript = await fs.readFile(path.join(root, 'tools/macos/install-update-release.sh'));
  const caddyPath = path.join(root, 'tools/self-host/Caddyfile.domain');
  run('scp', [bundlePath, signaturePath, manifestPath, caddyPath, 'qbank-pve:/tmp/']);
  run('ssh', ['qbank-pve', `QBANK_RELEASE_VERSION=${version} sh -s`], { input: installScript });
}

const mode = process.argv[2] || 'release';
if (!['release', '--build-only', '--deploy-only'].includes(mode)) {
  throw new Error('Usage: pnpm release:mac [--build-only|--deploy-only]');
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('macOS arm64 release requires an Apple Silicon Mac.');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a stable SemVer version, got ${version}`);

const cargoToml = await fs.readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const tauriConfig = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
if (!new RegExp(`^version\\s*=\\s*"${version.replaceAll('.', '\\.') }"$`, 'm').test(cargoToml)
  || tauriConfig.version !== version) {
  throw new Error('package.json, src-tauri/Cargo.toml, and tauri.conf.json versions must match.');
}

const bundlePath = path.join(releaseDir, assetName);
const signaturePath = `${bundlePath}.sig`;
const manifestPath = path.join(releaseDir, 'latest.json');

if (mode !== '--deploy-only') {
  if (await exists(releaseDir)) throw new Error(`Release artifacts already exist for ${version}; use --deploy-only or increment the version.`);
  const password = (await fs.readFile(passwordPath, 'utf8')).trim();
  if (!password || !(await exists(keyPath)) || !(await exists(publicKeyPath))) {
    throw new Error('Missing local updater key. Preserve .local/macos-updater.key, its .pub file, and .local/macos-updater.password.');
  }
  const publicKey = (await fs.readFile(publicKeyPath, 'utf8')).trim();
  const publicKeyText = Buffer.from(publicKey, 'base64').toString('utf8');
  if (!publicKeyText.startsWith('untrusted comment:')) throw new Error('Invalid Tauri updater public key file.');

  const env = {
    ...process.env,
    QBANK_UPDATER_ENDPOINT: endpoint,
    QBANK_UPDATER_PUBLIC_KEY: publicKey,
    TAURI_SIGNING_PRIVATE_KEY: keyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
  };
  const updaterConfigPath = path.join(root, '.local/macos-updater-tauri.json');
  await fs.writeFile(updaterConfigPath, JSON.stringify({ plugins: { updater: { pubkey: publicKey, endpoints: [endpoint] } } }, null, 2), { mode: 0o600 });
  run(process.execPath, ['scripts/tauri.mjs', 'build', '--config', updaterConfigPath, '--bundles', 'app'], { env });

  const builtApp = path.join(root, 'src-tauri/target/release/bundle/macos/题库.app');
  if (!(await exists(builtApp))) throw new Error(`Tauri did not create ${builtApp}`);
  if (appVersion(builtApp) !== version) throw new Error('Built app version does not match the release version.');
  const bundleDir = path.dirname(builtApp);
  const updaterArtifacts = (await fs.readdir(bundleDir)).filter(file => file.endsWith('.app.tar.gz'));
  if (updaterArtifacts.length !== 1) throw new Error(`Expected one macOS updater .app.tar.gz, found ${updaterArtifacts.length}.`);
  const builtArchive = path.join(bundleDir, updaterArtifacts[0]);
  const builtSignature = `${builtArchive}.sig`;
  const signature = (await fs.readFile(builtSignature, 'utf8')).trim();
  if (!signature) throw new Error('Tauri did not create a non-empty updater signature.');

  await fs.mkdir(releaseDir, { recursive: true });
  await fs.copyFile(builtArchive, bundlePath, constants.COPYFILE_EXCL);
  await fs.copyFile(builtSignature, signaturePath, constants.COPYFILE_EXCL);
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'darwin-aarch64': { signature, url: assetUrl },
    },
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });

  const deliveryPath = path.join(root, '交付/题库.app');
  const stagePath = path.join(root, `交付/.题库.app-stage-${process.pid}`);
  const oldPath = path.join(root, `交付/.题库.app-old-${process.pid}`);
  await fs.mkdir(path.dirname(deliveryPath), { recursive: true });
  if (await exists(deliveryPath)) {
    const oldVersion = appVersion(deliveryPath);
    if (oldVersion !== version) {
      const backupPath = path.join(root, `.local/macos-release-backups/${oldVersion}-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}/题库.app`);
      await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      run('/usr/bin/ditto', ['--rsrc', '--extattr', deliveryPath, backupPath]);
      console.log(`Saved previous delivery app ${oldVersion} under .local/macos-release-backups.`);
    }
    if (await exists(oldPath)) throw new Error(`Refusing to overwrite stale staging path ${oldPath}`);
  }
  if (await exists(stagePath)) throw new Error(`Refusing to overwrite stale staging path ${stagePath}`);
  run('/usr/bin/ditto', ['--rsrc', '--extattr', builtApp, stagePath]);
  const hadOld = await exists(deliveryPath);
  if (hadOld) await fs.rename(deliveryPath, oldPath);
  try {
    await fs.rename(stagePath, deliveryPath);
  } catch (error) {
    if (hadOld) await fs.rename(oldPath, deliveryPath);
    throw error;
  }
  if (hadOld) await fs.rm(oldPath, { recursive: true, force: true });
  run('codesign', ['--verify', '--deep', '--strict', deliveryPath]);

  const stat = await fs.stat(bundlePath);
  console.log(`Prepared macOS ${version}: ${deliveryPath}`);
  console.log(`Signed updater bundle: ${bundlePath} (${(stat.size / 1048576).toFixed(1)} MB)`);
  console.log(`Updater feed: ${manifestPath}`);
}

if (mode !== '--build-only') {
  if (!(await exists(bundlePath)) || !(await exists(signaturePath)) || !(await exists(manifestPath))) {
    throw new Error(`Missing saved release files in ${releaseDir}; build once before deploying.`);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const signature = (await fs.readFile(signaturePath, 'utf8')).trim();
  if (manifest.version !== version || manifest.platforms?.['darwin-aarch64']?.signature !== signature
    || manifest.platforms?.['darwin-aarch64']?.url !== assetUrl) {
    throw new Error('Saved update manifest does not match this release.');
  }
  await deploy(bundlePath, signaturePath, manifestPath);
  console.log(`Published ${version} to ${endpoint}; previous host releases are retained.`);
}
