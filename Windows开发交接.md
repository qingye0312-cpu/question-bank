# Windows 开发交接

更新日期：2026-10-14。交接验证版本：0.2.4；后续以 `package.json`、Cargo 和 Tauri 配置中的一致版本为准。

仓库：[qingye0312-cpu/question-bank](https://github.com/qingye0312-cpu/question-bank)（私有）。Mac 与 Windows 共用源码；Windows 适配在临时分支验证后合回 `main`。

## 1. 接手目标与现状

当前是 Tauri 2 + React 19 / TypeScript + Rust / SQLite 的离线桌面题库。已有搜索、录题维护、回收站、修订记录、标准文件导入导出、离线题库包，以及截图 / 图片粘贴 / 文字粘贴识题。首次使用全新数据目录，会载入 914 题的「HarmonyOS 初级认证」只读发布题库。

Windows 接手的目标是：在 Windows 原生环境完成安装依赖、编译、实际运行、功能验证和 NSIS 安装包验证，并保留 Mac 现有功能。

| 部分 | 当前依据 | Windows 接手工作 |
| --- | --- | --- |
| 通用界面、数据库、搜索、导入导出 | 已有代码与自动化测试；Mac 有本机验证记录 | Windows 重跑测试并检查界面和文件操作 |
| Windows 系统 OCR | `Windows.Media.Ocr` 适配已实现；历史记录只有模块接口交叉编译检查 | 验证完整应用编译、语言包和运行时可用性 |
| Windows 截图与剪贴板 | `ms-screenclip:`、剪贴板序号检查、图片 / 文字读取已实现 | 实测截图、取消、超时、粘贴、多屏与缩放 |
| 内置 OCR | Tesseract.js 7，中英文模型已固定并随源码提交；Mac WebView 已运行 | 验证 Windows WebView2 的 Worker / WASM 和离线识别 |
| Windows 安装包 | 尚未完成 Windows 实机构建、安装和升级验证 | 构建 NSIS，安装后再验证应用 |

Mac 的通过结果和 Windows 模块的类型检查，都不能代替 Windows 安装包及实机验收。全局快捷键、托盘、单实例、签名、导入进度与取消等仍属于后续工作；现有识题快捷键是应用内快捷键。

## 2. 仓库包含什么

| 随 Git 提交 | 用途 |
| --- | --- |
| `src/`、`src-tauri/src/`、`src-tauri/native/` | 共享界面、Rust 后端、系统适配 |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`src-tauri/Cargo.lock` | 固定依赖与构建设置 |
| `src-tauri/resources/seed.json`、`examples.json` | 内置题库与测试示例；编译时需要 |
| `public/ocr/lang/*.traineddata`、`assets/ocr/` | 中英文模型、指纹清单与第三方许可证 |
| `templates/`、`tests/`、`src-tauri/tests/` | 标准导入模板、OCR 样本与测试 |
| `docs/`、已确认规划、历史待审核规划 | 项目依据；需求冲突时以已确认规划和当前明确要求为准 |

`.gitignore` 排除依赖缓存、`.tooling/`、`target/`、`dist/`、Tauri 生成文件、本机 `.local/` 数据库、`artifacts/` 日志和性能数据、`交付/` 安装包、根目录旧 Word 及 `备份_原题库/`。原有文件保留在 Mac 本机，不会因仓库整理而删除。

`public/ocr/core/`、`worker.min.js`、`licenses/` 是生成资源，由 `scripts/prepare-ocr.mjs` 从已安装依赖重建；`public/ocr/lang/` 是必须提交的原始模型。该脚本会校验模型的大小和 SHA-256，校验失败应恢复对应文件，不能跳过校验。

`.gitattributes` 统一源码使用 LF 换行，模板、图片和模型按二进制保存，避免 Windows 换行转换破坏文件或模型指纹。

## 3. Windows 环境准备

首轮以 Windows 11 x64 原生环境为验证目标。若实际机器是 ARM64，先确认 CPU、Rust host 和 MSVC 组件，再选择对应构建目标；不要把 x64 结果当作 ARM64 结果。

在 Windows 上使用 Codex 的本地项目与原生 PowerShell。依赖由 Windows 安装，Mac 的 `.tooling/` 和 `node_modules/` 无需复制。

| 工具 | 要求 |
| --- | --- |
| Git for Windows | 能访问此私有 GitHub 仓库；GitHub 凭据与 Codex 登录分别配置 |
| Node.js | 至少 22.18；本轮 Mac 验证版本为 24.19.0，可优先使用 Node 24 系列 |
| pnpm | `11.25.0`，与 `package.json` 的 `packageManager` 一致 |
| Rust / Cargo | 稳定版、MSVC host；本轮 Mac 使用 Rust / Cargo 1.99.0 |
| Microsoft C++ Build Tools | 安装「使用 C++ 的桌面开发」工作负载及对应 MSVC、Windows SDK |
| Microsoft Edge WebView2 Runtime | 安装或确认现有运行时可用 |

平台安装步骤参考 [Tauri 官方 Windows 前置依赖](https://v2.tauri.app/start/prerequisites/#windows)。pnpm 安装方式参考 [pnpm 官方说明](https://pnpm.io/installation/)，本项目保持已验证版本。

安装 Node.js 后，在 PowerShell 执行：

```powershell
npm install --global pnpm@11.25.0
```

重新打开终端或 Codex，使 PATH 更新生效，再检查：

```powershell
git --version
node --version
pnpm --version
rustc -Vv
cargo --version
rustup show active-toolchain
```

x64 Windows 的 Rust host 应为 `x86_64-pc-windows-msvc`。若缺少 C++ 链接器，先修复 Build Tools / SDK 安装；若普通终端没有相应环境，可在 Visual Studio 的 Developer PowerShell 中检查。PowerShell 若拦截 `npm.ps1` / `pnpm.ps1`，可改用同名 `.cmd` 启动器执行这些命令。

## 4. 获取源码、检查和运行

以下命令按段执行，上一段报错时先处理，不继续打包。尚未登录 GitHub 时可使用 Git Credential Manager，或安装 GitHub CLI 后执行 `gh auth login`，使用 `qingye0312-cpu` 或其他有该私有仓库访问权限的账户。

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\source" | Out-Null
Set-Location "$env:USERPROFILE\source"
git clone https://github.com/qingye0312-cpu/question-bank.git
Set-Location .\question-bank
git switch -c windows/first-validation
```

在 Windows Codex 中把 `question-bank` 文件夹添加为本地项目。分支名称是首轮示例；已经存在时切换到已有分支，不重复创建。

```powershell
pnpm install --frozen-lockfile
pnpm test:ui
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --test core --test ocr
```

`pnpm build` 会依次准备 OCR 资源、检查 TypeScript、生成前端。第一次安装会下载依赖；如果锁文件检查失败，先定位版本或配置差异，不删除锁文件重新解析依赖。`pnpm-workspace.yaml` 已允许 esbuild 的必要安装脚本，并明确跳过 Tesseract.js 的赞助提示脚本，新电脑无需交互批准这两个依赖。

使用独立测试数据目录启动桌面开发版：

```powershell
$env:QBANK_DATA_DIR = Join-Path (Get-Location) '.local\windows-validation'
pnpm tauri dev
```

第一次 Cargo 编译可能较久。只运行 `pnpm dev` 是浏览器前端调试，完整桌面功能应使用 `pnpm tauri dev`。

`QBANK_DATA_DIR` 只作用于当前 PowerShell 及其子进程。从开始菜单打开安装后的程序，不会自动继承此终端设置。正常数据目录由 Tauri 按系统确定，以应用「设置与维护」显示的数据库路径为准。

## 5. 构建和验收 Windows 安装包

关闭开发版之后，在 Windows 项目根目录运行：

```powershell
pnpm tauri build --bundles nsis -- --locked
Get-ChildItem .\src-tauri\target\release\bundle\nsis\*.exe
```

当前 `src-tauri/tauri.conf.json` 的默认打包目标为 Mac 的 `app`，因此 Windows 必须显式传 `--bundles nsis`。上面的输出路径适用于未指定 `--target`、未覆盖 `CARGO_TARGET_DIR` 的本机 release 构建。若后续增加 Windows 专用配置，优先用平台配置文件，保留 Mac 配置及 `local.questionbank.desktop` 应用标识。

首次打包可能下载 NSIS 等工具。生成 `.exe` 后还要实际安装、启动并测试，不能只凭打包命令成功就标记完成。当前尚无 Windows 签名和发布流水线。

应用内容和 OCR 模型可离线使用，但安装器在目标机器缺少 WebView2 时，默认处理方式可能需要联网。若要求完全离线安装，应在 Windows 阶段配置并验证 WebView2 的离线安装方式，参见 [Tauri Windows 安装器说明](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)。

### 必须实测的功能

- [ ] 全新测试目录首次启动载入 914 题；退出重开后数据、当前题库、模式、字号和配色正常。
- [ ] 详细模式与极速模式都能搜索题干、选项、标签、章节、编号，不搜索解析；中文输入、空格多词、引号短语与多色高亮正确。
- [ ] 极速模式逐字搜索，只在当前题库查询；长列表滚动继续加载，旧请求不会覆盖新查询；长词、高 DPI 和不同字号不遮挡答案。
- [ ] 新建题库、建立可编辑副本、编辑、删除、回收站恢复均正常；发布题库仍只读。
- [ ] Excel / Word / JSONL 导入预览及导出正常；标准模板可下载；中文、空格路径及对话框取消正常。
- [ ] `.qbank.zip` 制包、导入、重复导入、版本更新及回退正常；Mac 与 Windows 交换同一包可读取。
- [ ] 图片文件、拖入图片、`Ctrl+V`、识题面板「粘贴识别」、完整文字粘贴均可工作；短关键词仍正常搜索。
- [ ] `Ctrl+Shift+O` 在应用内打开识题；「截取屏幕」启动 Windows 截图工具，拿到新截图，截图后恢复窗口。
- [ ] 截图 Esc 取消、超时和失败能恢复窗口，取消不会误用剪贴板旧图片；验证多屏及 100% / 150% / 200% 缩放。
- [ ] 系统 OCR 的中文能力可用；系统 OCR 不可用时能回退内置引擎；手动选择内置引擎后断网识别成功。
- [ ] 文字样本 `tests/fixtures/ocr/multiple-reordered.txt` 能把选项换序映射为 B、C、D；对应图片若 OCR 有错字，应能保留候选供确认。
- [ ] `true-false.png` / `single-code.png`、无匹配、空答案及相似题场景均有合理结果；不要把低质量 OCR 候选当作确定答案。
- [ ] 安装包在实际 Windows 环境安装后能够启动和完成上述核心功能；升级、卸载及用户数据保留行为单独记录。

识题样本来自内置题库。系统 OCR 受语言包、应用包身份和系统版本影响，这些是需要验证的问题；本机接口检查没有证明运行时一定可用。截图调用使用 `ms-screenclip:`，若系统没有自动将新截图复制到剪贴板，应记录现象并验证 `Win+Shift+S` 后粘贴的备用入口。

## 6. 代码入口与已有依据

| 文件 | 关注内容 |
| --- | --- |
| `src/main.tsx`、`src/styles.css` | 主界面、导入维护流程、布局与样式 |
| `src/speed-results.tsx`、`src/search-presentation.ts` | 极速结果与搜索高亮 / 片段 |
| `src/ocr-panel.tsx`、`src/ocr-crop.tsx`、`src/ocr-client.ts` | 识题入口、裁切、粘贴判断、内置 OCR |
| `src-tauri/src/lib.rs` | Tauri 命令、数据目录及启动种子题库 |
| `src-tauri/src/db.rs`、`model.rs`、`exchange.rs` | 数据、搜索、约束和交换协议 |
| `src-tauri/src/ocr/windows.rs` | Windows OCR、截图、剪贴板 |
| `src-tauri/src/ocr/mod.rs`、`matching.rs` | 平台分发、输入边界、候选检索和选项映射 |
| `src-tauri/native/ocr_macos.m`、`src-tauri/build.rs` | Mac 实现与按平台编译；修改共享逻辑时保留此分支 |
| `src-tauri/src/bin/qbank-tool.rs` | 导入检查、制包和性能验证辅助程序 |

需求和已有验证入口：[已确认规划](系统级题库建设规划_已确认.md)、[本机验证报告](docs/本机验证报告.md)、[截图识题说明](docs/截图识题实现与验证.md)、[导入与离线包规范](docs/导入格式与离线包规范_v1.md)、[答案核对记录](docs/答案核对记录.md)。报告中引用的 `artifacts/` 是 Mac 历史本机产物，未随仓库提交；需要复测时在 Windows 重新生成日志。

标准模板已经提交，正常编译无需重建。`scripts/build_templates.mjs` 依赖 Codex 工作区提供的 `@oai/artifact-tool`，不在普通应用依赖内；Word 模板重建另需 `python-docx` 及合适字体。`scripts/migrate_legacy.py` 是一次性迁移工具，依赖本次未入库的原始 Word；不要在普通新克隆目录运行它以覆盖现有 `seed.json`。

`scripts/env.sh` 是可选的 Mac / POSIX 辅助入口，会复用存在的 `.tooling/`，否则使用系统工具；Windows 原生 PowerShell 按本文命令运行即可。

## 7. 数据保护与两台电脑同步

源码通过 Git 同步，题目内容通过应用导出的 `.qbank.zip` 交换。离线包是发布快照，不包含完整编辑历史或原始 Word；完整工作区备份要先退出应用，再复制设置中显示的整个数据目录。不要让两台电脑同时打开网盘中的同一个 SQLite 文件。

正常开发不运行 `migrate_legacy.py`，不重置内置题库身份、不重写已确认答案，也不把性能测试数据写入正式目录。已有待核对题继续保留待核对状态。

切换电脑前提交并推送；另一台电脑先确认没有未提交修改，再拉取相同分支。不要同时在两台电脑上编辑同一分支后相互覆盖。锁文件、模型、模板和源码一起提交，缓存、数据库和安装包继续留在忽略目录。

Windows 首轮完成后可执行：

```powershell
git status --short
git diff --check
git add .
git diff --cached --check
git diff --cached --stat
git commit -m "Validate and adapt Windows desktop build"
git push -u origin windows/first-validation
```

提交前逐项检查文件；将 Windows 系统版本、架构、工具链、测试结果、安装器文件名与 SHA-256、通过和未通过的实测项补到本文，再合回 `main`。安装器校验值可用 `Get-FileHash <安装器路径> -Algorithm SHA256` 获取。

## 8. 本轮仓库整理验证

本节记录仓库整理阶段的实际检查，不代表 Windows 已完成验收。整理环境为 Apple Silicon Mac；Windows 完整编译、安装、升级与上述实测项仍待完成。

验证对象是仅从 Git 暂存区导出的源码副本，不包含原项目的 `node_modules/`、生成 OCR 资源、`dist/` 或本机数据库。依赖安装复用了本机 pnpm 缓存，Rust 测试复用了现有工具链和编译缓存；这些缓存没有进入仓库。

| 检查 | 结果 |
| --- | --- |
| 提交文件与体积 | 80 个文件，约 8.7 MiB；无依赖缓存、本机数据库、原始 Word、日志或安装包 |
| 必需资源 | Rust `include_str!` / `include_bytes!` 引用文件全部在提交范围内；模板、样本及模型齐全 |
| OCR 模型 | 源码、暂存区导出副本和构建后资源的中英文模型 SHA-256 均与清单一致 |
| 依赖安装 | pnpm 11.25.0 按 `--frozen-lockfile` 安装通过；已有缓存支持本轮离线安装 |
| 前端测试 | `pnpm test:ui`：12 项通过 |
| 前端构建 | `pnpm build`：TypeScript 检查、Vite 构建通过，Worker / WASM / 模型及许可证进入输出目录 |
| Rust 回归 | Mac 上 `cargo test --locked --offline ... --test core --test ocr`：核心 16 项、OCR 8 项通过 |
| 脚本与 Git | Shell / Node 脚本语法检查、交接文档链接检查及 `git diff --cached --check` 通过 |

上述结果随本次初始化提交保存。Windows 端应在自身环境重新执行第 4～5 节，并追加实际结果；这里只确认可提交源码的完整性及 Mac 上的回归结果。

## 9. 给 Windows Codex 的接手提示

可复制下面这段作为新聊天的第一条消息：

> 这是从 qingye0312-cpu/question-bank 克隆的离线题库项目。请先阅读根目录 Windows开发交接.md 和 README.md，保留 Mac 功能、应用标识、题库数据、两种搜索模式及既有答案规则。在 Windows 原生环境核对依赖并执行本文的测试、开发运行和 NSIS 构建；遇到平台问题做最小修改。完成后实际安装并验证截图、图片与文字粘贴、系统 / 内置 OCR、选项换序和离线题库包。请明确区分编译通过、自动化测试通过和 Windows 实机通过，把结果与未解决事项更新到 Windows开发交接.md。
