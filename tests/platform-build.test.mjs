import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {platformArgs} from '../scripts/tauri.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = platform => path.join(root, platform, 'tauri.conf.json');

test('desktop dev/build/bundle load the host configuration before user overrides', () => {
  for (const [host, platform] of [['darwin', 'mac'], ['win32', 'windows']]) {
    for (const command of ['dev', 'build', 'bundle']) {
      const args = [command, '--config', '{"bundle":{"active":false}}', '--', '--locked'];
      assert.deepEqual(platformArgs(args, host), [command, '--config', config(platform), ...args.slice(1)]);
      assert.equal(args.length, 5);
    }
  }
});

test('explicit Rust targets select the platform independently of the host', () => {
  for (const flag of [['--target', 'x86_64-pc-windows-msvc'], ['--target=x86_64-pc-windows-msvc'], ['-t', 'x86_64-pc-windows-msvc'], ['-tx86_64-pc-windows-msvc']]) {
    assert.deepEqual(platformArgs(['build', ...flag], 'darwin'), ['build', '--config', config('windows'), ...flag]);
  }
  assert.equal(platformArgs(['build', '-t', 'universal-apple-darwin'], 'win32')[2], config('mac'));
  assert.deepEqual(platformArgs(['build', '-t', 'x86_64-unknown-linux-gnu'], 'darwin'), ['build', '-t', 'x86_64-unknown-linux-gnu']);
});

test('Cargo arguments and non-build commands are forwarded without reinterpretation', () => {
  const args = ['build', '--', '--target', 'x86_64-pc-windows-msvc'];
  assert.deepEqual(platformArgs(args, 'darwin'), ['build', '--config', config('mac'), ...args.slice(1)]);
  for (const args of [[], ['--version'], ['info'], ['icon', 'icon.png']]) {
    assert.deepEqual(platformArgs(args, 'win32'), args);
  }
});

test('platform packaging retains the validated installers, deployment target and real icons', () => {
  const mac = JSON.parse(fs.readFileSync(config('mac')));
  const windows = JSON.parse(fs.readFileSync(config('windows')));
  assert.deepEqual(mac.bundle.targets, ['app']);
  assert.deepEqual(mac.build.additionalWatchFolders, ['../mac']);
  assert.equal(mac.bundle.macOS.minimumSystemVersion, '13.0');
  assert.deepEqual(windows.bundle.targets, ['nsis']);
  assert.deepEqual(windows.build.additionalWatchFolders, ['../windows']);
  assert.deepEqual(windows.bundle.windows.webviewInstallMode, {type: 'offlineInstaller', silent: true});
  assert.deepEqual(windows.bundle.windows.nsis, {
    installMode: 'currentUser',
    installerIcon: '../windows/icons/icon.ico',
    uninstallerIcon: '../windows/icons/icon.ico',
    installerHooks: '../windows/installer-hooks.nsh',
    languages: ['SimpChinese', 'English'],
  });
  for (const settings of [mac, windows]) {
    for (const icon of settings.bundle.icon) assert.ok(fs.existsSync(path.resolve(root, 'src-tauri', icon)), icon);
  }
  assert.ok(fs.existsSync(path.resolve(root, 'src-tauri', windows.bundle.windows.nsis.installerHooks)));
  const installerHooks = fs.readFileSync(path.resolve(root, 'src-tauri', windows.bundle.windows.nsis.installerHooks), 'utf8');
  assert.match(installerHooks, /NSIS_HOOK_POSTINSTALL[\s\S]*Call CreateOrUpdateDesktopShortcut/);
  assert.match(installerHooks, /\$UpdateMode = 1[\s\S]*\$NoShortcutMode = 0[\s\S]*IfFileExists[\s\S]*CreateShortcut/);
});
