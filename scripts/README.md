# scripts

这里放可重复的仓库级脚本，不保存运行状态。

| 脚本 | 用途 |
| --- | --- |
| `sync-client-assets.mjs` | 从 `desktop/shared/` 生成桌面和小程序共享副本 |
| `build-miniprogram-vendor.mjs` | 构建小程序 vendor |
| `prepare-ocr.mjs` | 准备 OCR 运行资源 |
| `tauri.mjs` | 为主机/目标平台选择 macOS 或 Windows Tauri 配置 |
| `build-self-host.mjs`、`release-self-host.mjs` | 服务端打包和版本发布 |
| `release-fastdownload.mjs` | 快速下载实验构建 |

脚本应保持幂等：同一输入重复执行得到相同生成文件，不读取凭据和本机数据库作为隐式源。
