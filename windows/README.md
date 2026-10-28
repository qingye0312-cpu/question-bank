# Windows 专用代码

`windows/` 只放 Windows OCR、图标、NSIS 配置、安装器钩子和 smoke/benchmark 脚本。

- `tauri.conf.json`：NSIS、更新归档和 WebView2 安装模式。
- `installer-hooks.nsh`：安装/更新后的快捷方式处理。
- `scripts/build-portable.ps1`：固定文件名 `题库_windows_x64_portable.exe` 的便携版构建。
- `scripts/windows-smoke.mjs`、`windows-ui-benchmark.mjs`：安装后和 UI 性能检查。

Windows 正式发布在 GitHub Actions 中拆成便携版和安装版两个独立 job，二者使用独立 artifact 和 Rust cache。
