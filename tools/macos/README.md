# macOS 构建

本机 Apple Silicon 构建只负责生成 `.app` 与 Tauri 更新归档，不再单独发布 macOS 的 `latest.json`。跨平台正式发布由 [桌面版构建发布与自动更新](../../docs/桌面版构建发布与自动更新.md) 工作流完成，统一包含 macOS 和 Windows，避免单个平台覆盖公共更新清单。

运行 `pnpm release:mac` 或 `pnpm release:mac --build-only` 可在本机执行签名构建。它需要保留原有的 `.local/macos-updater.key`、`.pub` 与 `.local/macos-updater.password`；这些密钥用于给安装版客户端签名验证更新，不能重新生成，也不能放进仓库或小主机。

跨平台发布请将版本号同步到 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock`，提交后推送对应的 `vMAJOR.MINOR.PATCH` 标签。GitHub Actions 会在原生 Apple Silicon 与 Windows x64 构建机上构建并签名两端，然后发布同一份更新清单。
