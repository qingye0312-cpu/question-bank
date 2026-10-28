# macOS 专用代码

`mac/` 只放 macOS 原生 OCR、图标、Tauri 合并配置和本机构建包装脚本。

- `native/ocr_macos.m`、`src/ocr.rs`：Vision/AppKit OCR 与剪贴板。
- `tauri.conf.json`：macOS app、DMG 和更新包配置。
- `scripts/env.sh`：统一 Node/pnpm/Rust 环境和工作目录。

普通 App 构建命令：

```sh
sh mac/scripts/env.sh pnpm tauri build --bundles app
```

唯一保留的 App 是根目录 `build/题库.app`；跨平台发布由 `.github/workflows/desktop-release.yml` 完成。
