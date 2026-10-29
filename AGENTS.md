# 项目协作约定

## 每轮开始前保存本地版本

- 每一轮新请求开始时先检查仓库、分支和 `git status`。
- 有未提交工作时先做一次本地快照提交，说明中写明本轮开始前快照和范围；工作区干净时不创建空提交。
- 遵守 `.gitignore`，不提交数据库、密钥、依赖、构建缓存、发布包和本机证据。
- 仅允许本地提交；不自动 push、不改写历史、不用重置或清理用户文件解决冲突。

## 目录和产物

- 桌面端源代码统一放在 `desktop/`：`desktop/src/` 是前端，`desktop/shared/` 是跨桌面/小程序共享层，`desktop/src-tauri/` 是 Rust/Tauri 层。平台专用代码仍在根目录 `mac/` 与 `windows/`。
- 普通 macOS App 的唯一输出是仓库根目录 `build/题库.app`，命令为 `sh mac/scripts/env.sh pnpm tauri build --bundles app`。
- 临时前端与 Rust 缓存只放在 `build/` 或被忽略的 `desktop/src-tauri/target/`，完成后清理；`build/` 不放说明文件。
- `pnpm release:mac` 是独立的更新发布流程，不作为普通 App 构建出口。

## 代理使用

GitHub 相关活动通过已配置的 Clash Verge `7897` 端口执行，不自动推送。

## SSH 主机拓扑

| SSH 别名 | 地址 | 角色 | 说明 |
| --- | --- | --- | --- |
| `qbank-frps` | `8.141.124.97:22` | 公网转发机 | 公网入口和转发主机，不承载题库服务，不作为 `qbank-auth` 部署目标。 |
| `qbank-pve` | `8.141.124.97:8013` | 公网服务入口 | 经公网转发进入 PVE 容器 `101`；登录后位于 `frpc-ssh-8013`，题库服务和 `/opt/qbank-auth` 在此容器内。 |
| `qbank-pve-lan` | `192.168.100.2:22` | 局域网 PVE 主机 | Proxmox 主机 `star`；容器 `101` 的局域网地址为 `192.168.100.250`。 |

- 拓扑关系：公网转发机将 `8.141.124.97:8013` 转发到 PVE 主机上的容器 `101`；`qbank-auth` 只部署在容器 `101` 内。
- 公网 SSH 入口受限时，可通过 `qbank-pve-lan` 登录 PVE 主机，再使用 `pct exec 101 -- ...` 管理容器；不要改用 `qbank-frps` 的 `22` 端口部署题库服务。
