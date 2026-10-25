# macOS 自动更新发行

当前分发目标为 Apple Silicon（`darwin-aarch64`）。`pnpm release:mac` 只构建 `.app` 和 Tauri 更新器需要的签名 `.app.tar.gz`，把 App 放进 `交付/题库.app`，并通过 `qbank-pve` SSH 发布静态更新索引和版本化更新包。小主机保留各个版本，`latest.json` 是唯一会切换的活动版本指针。

Tauri 更新包是完整 `.app` 的压缩归档，不是按字节差分补丁。发行目录里不生成 DMG 或 ZIP，也不会向 `交付` 写入额外压缩包。

## 更新签名密钥

第一次发行用 Tauri CLI 创建一组专用密钥，并把公钥文件、私钥文件与密码分别保存在 `.local/macos-updater.key.pub`、`.local/macos-updater.key`、`.local/macos-updater.password`。这些文件被 Git 忽略，发行脚本不会打印密钥。私钥和密码应另行安全备份；丢失私钥后，已安装的自动更新版无法接收后续签名更新。不可在服务器保存私钥。

该仓库首次发布使用的本机密钥已经生成。以后发行只要保留这三个文件即可；不要重新生成密钥，也不要把 `.local` 加入 Git。

## 发布

1. 发布新版本前，将 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号同步递增。
2. 在仓库根目录运行 `pnpm release:mac`。脚本构建 App 与签名更新包、将原交付 App 备份到 `.local/macos-release-backups/`，再通过 SSH 上传文件并原子切换小主机的 `latest.json`。
3. 如果构建成功但 SSH 发布中断，可运行 `node tools/macos/release.mjs --deploy-only` 重新部署已保存的该版本。

程序完成本地题库初始化后会检查更新。发现较新签名版本时，先等正在编辑的页面关闭、当前操作完成，再锁定界面，自动下载、验签、安装并重启；离线或服务不可用时继续使用当前版本。此前没有更新源配置的 `0.2.7` 安装包无法自行发现更新，因此需先用 `交付/题库.app` 中的当前版本替换安装一次；从 `0.2.8` 起自动更新生效。

小主机目录为 `/var/lib/qbank-desktop-updates/`，其中 `releases/<version>/` 保存不可覆盖的 `.app.tar.gz`、签名和 SHA-256 清单，`latest.json` 指向当前稳定版。Caddy 只读公开 `/v1/desktop/*`；该目录与题库数据 `/var/lib/qbank-auth` 分离。
