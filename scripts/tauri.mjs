// Keep one desktop crate while loading the target platform's packaging settings.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {access, mkdir, rename, rm} from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

export function platformArgs(args, host = process.platform) {
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const command = options.findIndex(arg => ['dev', 'build', 'bundle'].includes(arg));
  if (command < 0) return [...args];

  let target;
  for (let i = command + 1; i < options.length; i++) {
    const arg = options[i];
    if (arg === '--target' || arg === '-t') target = options[++i];
    else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    else if (arg.startsWith('-t') && arg.length > 2) target = arg.slice(2).replace(/^=/, '');
  }
  const platform = target
    ? (target.endsWith('-apple-darwin') ? 'mac' : target.includes('-windows-') ? 'windows' : null)
    : ({darwin: 'mac', win32: 'windows'}[host]);
  if (!platform) return [...args];

  // Insert before user overrides and the Cargo `--` separator.
  return [
    ...args.slice(0, command + 1),
    '--config', path.join(root, platform, 'tauri.conf.json'),
    ...args.slice(command + 1),
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {run} = await import('@tauri-apps/cli');
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const buildIndex = options.indexOf('build');
  let target;
  for (let i = buildIndex + 1; buildIndex >= 0 && i < options.length; i++) {
    if (options[i] === '--target' || options[i] === '-t') target = options[++i];
    else if (options[i].startsWith('--target=')) target = options[i].slice('--target='.length);
    else if (options[i].startsWith('-t') && options[i].length > 2) target = options[i].slice(2).replace(/^=/, '');
  }
  const platform = target
    ? (target.endsWith('-apple-darwin') ? 'mac' : target.includes('-windows-') ? 'windows' : null)
    : ({darwin: 'mac', win32: 'windows'}[process.platform]);
  const macBuild = buildIndex >= 0 && platform === 'mac';
  const localMacBuild = macBuild && !process.env.TAURI_SIGNING_PRIVATE_KEY;
  const buildRoot = path.join(root, 'build');
  const cargoTarget = path.join(buildRoot, '.cargo-target');
  const targetRoot = target ? path.join(cargoTarget, target) : cargoTarget;
  const bundleDirectory = path.join(targetRoot, 'release', 'bundle', 'macos');
  const builtApp = path.join(bundleDirectory, '题库.app');
  const outputApp = path.join(buildRoot, '题库.app');
  const stagedApp = path.join(buildRoot, '.题库.app.next');
  process.chdir(root);
  try {
    if (localMacBuild) {
      await mkdir(buildRoot, {recursive: true});
      process.env.CARGO_TARGET_DIR = cargoTarget;
    }
    const runArgs = platformArgs(args);
    if (localMacBuild) {
      const runSeparator = runArgs.indexOf('--');
      runArgs.splice(runSeparator < 0 ? runArgs.length : runSeparator, 0,
        '--config', JSON.stringify({bundle: {createUpdaterArtifacts: false}}));
    }
    await run(runArgs, 'pnpm tauri');
    if (localMacBuild) {
      await access(builtApp);
      await rm(stagedApp, {recursive: true, force: true});
      await rename(builtApp, stagedApp);
      await rm(outputApp, {recursive: true, force: true});
      await rename(stagedApp, outputApp);
      await rm(bundleDirectory, {recursive: true, force: true});
    }
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    if (localMacBuild) {
      await rm(stagedApp, {recursive: true, force: true});
      await rm(cargoTarget, {recursive: true, force: true});
    }
    if (macBuild) {
      await rm(path.join(buildRoot, '.frontend-dist'), {recursive: true, force: true});
    }
  }
}
