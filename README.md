# 题库

本项目是一个本地优先的题目检索、录入、复习和云端协作工具，包含桌面端、微信小程序和自托管云服务。题库正式历史版本属于业务数据，保留在云端存储、题库数据和 [`data/formal-history/`](data/formal-history/) 原始资料中；代码、构建产物和运行证据只维护当前实现。

## 先看哪里

| 目标 | 入口 |
| --- | --- |
| 桌面端界面与业务 | [`desktop/`](desktop/)、[`desktop/README.md`](desktop/README.md) |
| 桌面端共用逻辑 | [`desktop/shared/`](desktop/shared/README.md) |
| Tauri/Rust 本机能力 | [`desktop/src-tauri/`](desktop/src-tauri/README.md) |
| 微信小程序 | [`miniprogram/`](miniprogram/README.md) |
| 自托管云服务 | [`cloud/`](cloud/README.md) |
| macOS / Windows 专用代码 | [`mac/`](mac/README.md)、[`windows/`](windows/README.md) |
| 构建、同步和部署脚本 | [`scripts/`](scripts/README.md)、[`tools/`](tools/README.md) |
| 自动化测试 | [`tests/`](tests/README.md) |
| 正式题库原始版本资料 | [`data/formal-history/`](data/formal-history/README.md) |
| 设计、发布与运维说明 | [`docs/`](docs/README.md) |

完整的当前架构和数据边界见 [`开发文档.md`](开发文档.md)。

## 当前实现边界

- 桌面端使用 React、TypeScript、Vite、Tauri 2、Rust 和 SQLite，支持 macOS 与 Windows。
- 小程序使用原生页面和 TypeScript；共享题目协议、压缩、同步和外观代码从 `desktop/shared/` 生成到小程序 `core/`。
- 云服务使用 `cloud/qbank-auth/` 的 Node.js 服务和文件存储，桌面端、小程序共用 HTTPS API。
- 正式题库内容只由云端发布流程改变；客户端同步时按目录修订号和摘要更新本地快照并重建索引，待上传草稿单独保存。
- 电话号码账号同一账号最多保留一个桌面会话和一个小程序会话；同类新登录会使旧会话失效。
- 所有全屏弹窗使用 `desktop/src/styles.css` 的统一宽度、比例和视口上限；具体页面只负责内容布局。

## 本地开发

需要 Node.js 22.18+ 和 pnpm 11。

```sh
pnpm install
pnpm tauri dev
```

常用检查：

```sh
sh mac/scripts/env.sh pnpm exec tsc --noEmit
sh mac/scripts/env.sh pnpm test:platforms
sh mac/scripts/env.sh pnpm test:ui
sh mac/scripts/env.sh pnpm test:desktop
sh mac/scripts/env.sh pnpm test:intake
sh mac/scripts/env.sh pnpm test:self-host
sh mac/scripts/env.sh pnpm check:miniprogram
```

macOS 普通 App 构建的唯一输出是根目录 [`build/题库.app`](build/题库.app)：

```sh
sh mac/scripts/env.sh pnpm tauri build --bundles app
```

不要把 `desktop/src-tauri/target/`、`dist/`、临时前端目录或旧 App 副本提交到仓库。正式跨平台发布由 [`desktop-release.yml`](.github/workflows/desktop-release.yml) 完成，macOS、Windows 便携版和 Windows 安装版三个构建 job 独立并行，`publish` 统一组装签名、清单和校验和。

## AI 修改检查清单

1. 先读本文件、目标目录 README、[`AGENTS.md`](AGENTS.md)，确认源文件与生成文件边界。
2. 先检查 Git 状态；本轮已有工作先保存为本地快照，不自动 push。
3. 只改 canonical source；`desktop/src/generated/` 和 `miniprogram/miniprogram/core/` 的生成文件通过 `node scripts/sync-client-assets.mjs` 更新。
4. 修改路径、协议或构建配置后，运行对应目录 README 中的最小检查，再运行 `git diff --check`。
5. 分开记录代码、构建包、GitHub Release、自托管清单、安装后的更新和浏览器/设备验证结果。
6. 变更正式题库历史时，保留每个正式版本及其修订记录；不要用代码清理动作删除业务历史。
