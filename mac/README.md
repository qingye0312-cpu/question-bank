# Mac 开发与构建

Mac 已构建基线为 `main` 的 `24f961e`（v0.2.6）。本目录保存 Mac 系统适配、打包配置、图标、环境入口和 [历史验证记录](docs/本机验证报告.md)。共享 React、Rust、题库及测试保留在仓库根目录，分支差异见 [平台目录与分支对比](../docs/平台目录与分支对比.md)。

| 路径 | 用途 |
| --- | --- |
| `src/ocr.rs` | Apple Vision 桥接、剪贴板、屏幕权限与主屏幕截图 |
| `native/ocr_macos.m` | Vision / AppKit / CoreGraphics 的 Objective-C 实现 |
| `build.rs` | Objective-C 编译与系统 framework 链接 |
| `tauri.conf.json`、`icons/icon.icns` | `.app` 打包、最低 macOS 13.0 与 Mac 图标 |
| `scripts/env.sh` | 从任意工作目录定位仓库，加载可选的 `.tooling/` 工具链 |

所有命令在仓库根目录执行，需要 Node.js 22.18+、pnpm 11.25.0、Rust 和 Xcode Command Line Tools。

```sh
pnpm install --frozen-lockfile
pnpm test:ui
pnpm test:platforms
cargo test --locked --manifest-path src-tauri/Cargo.toml --test core --test ocr
pnpm tauri dev
pnpm tauri build --bundles app -- --locked
```

`pnpm tauri` 会自动合并此目录的配置。使用工作区本地工具链时，可在命令前加 `sh mac/scripts/env.sh`，例如 `sh mac/scripts/env.sh pnpm tauri build --bundles app -- --locked`。直接调用原生 Tauri CLI 时，使用 `tauri build --config mac/tauri.conf.json --bundles app -- --locked`。

默认构建产物在 `src-tauri/target/release/bundle/macos/题库.app`；`--target` 或 `CARGO_TARGET_DIR` 会改变输出位置。`target/`、`交付/`、数据库和依赖缓存不随 Git 提交。历史 `.app`、签名和性能记录仍以原报告为准；目录整理本身不代表重新完成全部界面验收。
