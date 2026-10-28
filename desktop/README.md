# 桌面端

`desktop/` 是桌面端的统一源码目录，故意把前端、共享逻辑和 Tauri/Rust 放在同一边界内，便于构建、测试和让自动化代理定位源文件。

## 子目录

- [`src/`](src/README.md)：React 页面和桌面状态。
- [`shared/`](shared/README.md)：桌面与小程序共用的协议和纯逻辑。
- [`src-tauri/`](src-tauri/README.md)：Tauri 配置、Rust IPC、SQLite 和本机能力。

平台差异放在根目录 [`mac/`](../mac/README.md) 和 [`windows/`](../windows/README.md)，不复制到桌面共享目录。

## 修改规则

1. 共享题目协议只改 `shared/`，执行 `node scripts/sync-client-assets.mjs` 同步小程序生成文件。
2. 前端页面只改 `src/`；生成的 `src/generated/` 不手工编辑。
3. Rust 领域逻辑只改 `src-tauri/src/`，平台桥接使用 `mac/` 或 `windows/`。
4. 构建前先执行根目录 README 的 TypeScript 和平台检查；普通 macOS App 只保留 `build/题库.app`。
