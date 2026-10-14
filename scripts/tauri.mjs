// Keep one desktop crate while loading the target platform's packaging settings.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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
  process.chdir(root);
  try {
    await run(platformArgs(process.argv.slice(2)), 'pnpm tauri');
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
