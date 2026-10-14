# Windows 构建与验证报告

本文保留 `windows/first-validation` 的历史验证结果；脚本及配置路径已更新为平台目录布局，所有命令在仓库根目录执行。

日期：2026-10-14。应用版本：0.2.6，Windows x64 本机验证版。本轮从 `24f961e` 接手，工作分支为 `windows/first-validation`。原生编译、自动化回归、实际 WebView2 运行均已执行；尚待人工验收的项目单独列在末尾。

## 交付与环境

安装包：`交付/题库_0.2.6_x64-setup.exe`，234,480,475 字节（223.62 MiB）。SHA-256：

```text
7315a2abd57a3fdb27faa36a9a242cd2f2f3aaace0aad781a9f7ac22d1afc798
```

这是未签名的本机验证安装包，尚未完成 Windows 代码签名和公开发行验收。采用当前用户安装，支持简体中文和英语，嵌入 WebView2 离线安装器。嵌入安装器的微软签名检查结果为 `Valid`；本机已有 WebView2，因此尚未在全新、缺少 WebView2 的离线系统上实测其安装分支。

| 项目 | 实测环境 |
| --- | --- |
| 系统 | Windows 11 专业版 26H1，10.0.28000.2956，x64 |
| 硬件 | Intel Core i9-14900K，系统报告内存 31.74 GiB |
| 显示 | WebView 1320 × 850 CSS 像素，实际 devicePixelRatio 1.5 |
| Git | 2.56.0.windows.2 |
| Node / pnpm | 24.19.0 / 11.25.0 |
| Rust / Cargo | 1.99.0，stable-x86_64-pc-windows-msvc |
| C++ 工具 | Visual Studio Build Tools 2022 17.14.41；MSVC 14.44.35207 |
| Windows SDK | 10.0.26100.0 |
| WebView2 | 154.0.4258.53 |
| Tauri / NSIS / 自动化 | Rust 2.12.3、CLI 2.12.2；NSIS 3.11；Playwright 1.62.1 |

Rust 安装在当前工作区 `.tooling/`，PowerShell 可用 `. .\windows\scripts\env.ps1` 载入。依赖下载使用本机 Clash 代理；代理并非程序运行依赖，也未写入应用代码。

## 源码核对与修改

接手时工作区干净。清点原有 86 个受 Git 管理文件（9,184,725 字节），读取项目规划、交接、源码、脚本与测试；完整解析 914 条种子数据，读取 Office 压缩包各条目，校验模型与资源指纹。逐文件审计保存在本机 `artifacts/windows-source-audit.json`。锁文件由包管理器按锁定模式解析，未重新解析或升级依赖。

本轮修改：

- 增加 Windows 打包配置（现为 `windows/tauri.conf.json`），在 Windows 使用 NSIS、当前用户安装、中文界面及 WebView2 离线安装器；保留 Mac 配置和 `local.questionbank.desktop` 标识。
- 修复识题面板重复选择当前题库时，取消了匹配请求却不触发新查询的问题。Windows 剪贴板实测复现后修复，并由实际安装版验证覆盖。
- 增加 PowerShell 环境入口、真实 WebView2 功能验证和界面性能脚本，更新平台交接及验证记录。

未重新迁移题库或生成模板。种子数据仍为单选 501、多选 170、判断 243；J-137、J-145、S-371 保留空答案。种子文件 SHA-256 仍为 `56e869293fcd4f6c471f405bf4f6bf8a47072390132af30b9ce5ef732d62e78e`。

## 构建与回归

| 检查 | 结果 | 本机证据 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 通过 | `artifacts/windows-pnpm-install.log` |
| `pnpm test:ui` | 12 项通过 | `artifacts/windows-ui-tests.log` |
| `pnpm build` | 模型校验、TypeScript、Vite 通过 | `artifacts/windows-frontend-build.log` |
| `cargo test --locked … --test core --test ocr` | 核心 16 项、OCR 8 项通过 | `artifacts/windows-native-tests.log` |
| `pnpm tauri build --bundles nsis -- --locked` | Release 与 NSIS 成功 | `artifacts/windows-nsis-build.log` |
| 实际安装版 WebView2 功能验证 | 15 组通过 | `artifacts/windows-smoke-2026-10-14T15-29-28-950Z/report.json` |

构建存在 Cargo 的 Windows PDB 同名提示（`question-bank` 可执行目标与 `question_bank` 库目标）；本轮编译、链接、测试及运行成功。该提示未作为失败忽略或通过修改锁文件消除。

## Windows 程序实测

验证使用实际 `.exe`、WebView2、Tauri IPC 和 Rust/SQLite 后端，没有替换后端响应。测试数据与 WebView 配置保存在每次新建的 `artifacts/windows-smoke-*` 下。浏览器测试参照 [Playwright 官方 WebView2 方法](https://playwright.dev/docs/webview2)，本机调试端口只随测试进程存在。

15 组检查覆盖：

- 首次启动 914 题、按游标读取完整数据、题型数量、三个空答案、发布题库只读保护。
- 两种模式跨越第 50、100 题继续加载；详细模式加载至 150 题；极速模式完整题目预览、位置边界和 Esc 关闭。
- 实际检索、零命中、`Ctrl+K`、`Alt+↓`、`Ctrl+Shift+O`；组合输入事件期间不查询半成品，结束后更新。这里的组合输入由浏览器事件驱动，不等同于每一种实体输入法的人工验收。
- 四档字号、六种配色、侧栏和搜索区收起；真实退出重启后的模式、题库和偏好保留。
- Word、Excel、JSONL 的内嵌模板写出、预览、导入与导出；中文及空格文件路径；调用真实 Rust 文件接口。原生文件选择 / 保存对话框本身未自动点击。
- 建库、编辑、修订历史、删除和恢复、建立 914 题可编辑副本；离线包重复导入跳过、导入回退、索引重建；解析保存但不参与检索。版本更新和篡改保护另由 Rust 集成测试覆盖。
- Windows 原生剪贴板文字与 RGBA 图片读取，`Ctrl+V` 完整文字和图片、面板「粘贴识别」、图片拖入；测试结束恢复原有剪贴板内容。
- 系统 OCR 对判断、代码单选、换序多选三张 PNG 识别并检索到候选。换序文字自动显示 B、C、D；系统 OCR 有差异的图片先显示候选，人工确认路径显示 B、C、D。
- 实际 WebView2 中加载打包的 Worker、WASM、中英文模型；手动选择内置引擎识别成功。测试使用无效外部代理阻断 WebView 的外网访问，保留本机协议与 IPC；观测到的外部页面资源请求为零。没有断开全机网卡，不将此等同于全新离线系统安装测试。
- 内置 OCR 取消及再次输入恢复匹配；页面无未捕获异常。

首轮系统 OCR 对三张样本的耗时约 38–73 ms，另一次首次调用换序样本为 171 ms；内置引擎样本约 0.34 秒。仅为本机少量观察，不能推断所有图片的速度或准确率。内置样本将“沿”识别成“治”，说明候选确认和文字修改仍然必要。

## 安装、升级与数据保留

先将安装器实际安装到含中文和空格的 `artifacts/Windows 安装验证`，再从仓库真实旧提交 `972265b`（v0.2.4）独立构建旧版安装器。旧版仅补用相同 Windows 打包配置，应用源码和版本未伪造。

在 v0.2.4 的独立数据目录建立题目、修改历史和回收站，设置超大字体、海蓝和极速模式；使用最终 v0.2.6 安装器执行 `/S /UPDATE`。升级后注册表和实际应用均报告 0.2.6；题目内容、回收站、修订历史、914 题种子库及原有偏好逐项一致。新增预览偏好使用默认关闭。证据为 `artifacts/windows-upgrade/before.json` 与 `after-upgrade.json`。

随后静默卸载（未选择删除数据）：测试可执行文件和卸载注册项消失，独立测试数据库的 SHA-256 前后一致，均为 `88769e6f5bc7bb21483cd4f37a95d0bddc0ca002ab437f401a80e7cc965e8235`。将同一最终安装包重新安装到 `C:\Users\STAR\AppData\Local\题库` 后，使用原测试数据重新验证题目、回收站、历史和偏好，全部一致。证据为 `artifacts/windows-install-lifecycle.json` 及 `windows-upgrade/after-reinstall.json`。这是独立测试目录的数据保留实测；默认 AppData 的删除数据选项只审阅了生成的 NSIS 脚本，未勾选该选项删除用户目录。

最后取消测试数据环境变量，从标准安装路径启动程序：数据库实际位于 `C:\Users\STAR\AppData\Roaming\local.questionbank.desktop\question-bank.sqlite`，含 914 题发布库，性能模式关闭，没有混入测试题库。程序已安装到当前用户目录；最终正常启动的记录在 `artifacts/windows-normal-start.json`，截图为 `交付/Windows程序预览.png`。测试结束已退出调试进程。

## 性能

Release 构建，独立合成库，200 个查询场景、3 轮，每个规模 / 模式 600 个样本。核心测量包括连接、首批 50 条读取和反序列化；界面测量包括 React 状态、IPC、SQLite 和结果提交后的两次动画帧，不包括实体键盘或输入法时间。系统缓存未清空，后台负载与刷新率未锁定。

| 题量 | 核心 P95 | 核心 P99 | 初建索引 | 数据库体积 | 详细界面 P95 / P99 | 极速界面 P95 / P99 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 万 | 1.54 ms | 2.00 ms | 1.74 秒 | 35.61 MiB | 31.3 / 44.3 ms | 24.4 / 26.3 ms |
| 10 万 | 8.29 ms | 9.85 ms | 32.24 秒 | 319.05 MiB | 31.6 / 49.7 ms | 49.4 / 98.3 ms |

本机两种模式均达到 10 万题首批结果 P95 ≤ 100 ms 的目标。10 万题极速模式最大值 131.9 ms，不能宣称全部查询小于 100 ms。未在 Windows 重测百万题扩容观察。

证据：`artifacts/windows-bench-10k.report.json`、`windows-bench-100k.report.json`，以及 `windows-ui-benchmark-2026-10-14T15-24-35-681Z/` 和 `windows-ui-benchmark-2026-10-14T15-24-58-610Z/`。

## 复现

```powershell
. .\windows\scripts\env.ps1
pnpm.cmd install --frozen-lockfile
pnpm.cmd test:ui
cargo test --locked --manifest-path src-tauri/Cargo.toml --test core --test ocr
pnpm.cmd tauri build --bundles nsis -- --locked

# 验证工具使用 Playwright 1.62.1，无需下载 Chromium，直接连接系统 WebView2。
# 将 Playwright 安装到独立工具目录，不改动应用锁文件：
New-Item -ItemType Directory -Force .tooling/windows-ui | Out-Null
pnpm.cmd --dir .tooling/windows-ui --ignore-workspace add --save-exact playwright@1.62.1
$env:QBANK_PLAYWRIGHT_MODULE = Join-Path $PWD '.tooling/windows-ui/node_modules/playwright/index.mjs'
node windows/scripts/windows-smoke.mjs src-tauri/target/release/question-bank.exe

# benchmark 拒绝覆盖同名已有数据库；重复运行时使用新的输出文件名。
src-tauri/target/release/qbank-tool.exe benchmark 100000 artifacts/new-windows-bench.sqlite
node windows/scripts/windows-ui-benchmark.mjs src-tauri/target/release/question-bank.exe artifacts/new-windows-bench.sqlite
```

每次功能 / 界面测量会生成新的独立数据目录和 JSON 报告，失败返回非零退出码；不会主动删除既有数据库。测试脚本会操作应用窗口及短暂使用系统剪贴板。日志、截图、数据库、工具链和安装包按 `.gitignore` 保留在本机。

## 尚待人工或其他机器验证

- 系统截图 `ms-screenclip:` 的实际框选、新截图接收、Esc / 60 秒超时 / 失败后的恢复，以及旧剪贴板图片不被误用。
- 多显示器与 Windows 100% / 200% 缩放；本机实际测得 150%，未改变用户显示设置。
- 原生打开 / 保存对话框及取消、不同中文输入法、窗口边缘极长题目与长时交互。
- 缺少系统 OCR 语言包时的自动回退，以及缺少 WebView2 的全新离线安装；本机系统 OCR 和 WebView2 已具备，未移除系统共享组件来制造缺失环境。
- 与另一台 Mac 实机交换本轮生成的包、休眠恢复、长时内存、灾难恢复、Windows 其他版本及 ARM64。

本轮原生桌面自动化工具因沙箱初始化失败不可用，以上系统界面项目未伪记为通过。Playwright 验证的是实际程序的 WebView 和后端，无法替代这些系统操作。全局快捷键、托盘、单实例、签名、导入进度与取消仍按原规划后续实施。
