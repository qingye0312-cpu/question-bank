# macOS 发布工具

`tools/macos/release.mjs` 负责本机 Apple Silicon 的签名 App 和更新归档；它不是跨平台 GitHub 发布的替代入口。

```sh
sh mac/scripts/env.sh pnpm release:mac
```

版本校验读取根目录 `package.json`、`desktop/src-tauri/tauri.conf.json`、`desktop/src-tauri/Cargo.toml` 和 `Cargo.lock`。签名密钥只从本机环境或受保护的 CI secret 读取。普通本机构建只保留 `build/题库.app`，更新归档交由发布流程放入 `artifacts/` 或系统临时目录。
