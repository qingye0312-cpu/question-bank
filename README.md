# 题库 · 源码版 v0.2.7

新增大模型单题录入、三端提示词复制、增量包与小程序多题库切换。操作和人工验收见 [v0.2.7 使用说明](docs/v0.2.7_录题与增量包.md)。下方已有 v0.2.6 安装包为历史交付，本轮源码提交不等于重新发布安装包。

Tauri 2 + React + Rust / SQLite 桌面题库。数据保存在本机，搜索、录题、导入、导出和制作离线包均不需要联网。

平台专属代码分别位于 [mac/](mac/README.md)、[windows/](windows/README.md) 和 [miniprogram/](miniprogram/README.md)。小程序已实现内置 914 题的本地文字搜题、连续结果与详情，待真机验收；暂未接入下载、云服务、权限和加密。共享桌面前端、Rust 后端、题库资源和测试保留原有结构。两次桌面基线提交的差异和文件归属见 [平台目录与分支对比](docs/平台目录与分支对比.md)。

## 直接使用

Windows x64 使用 `交付/题库_0.2.6_x64-setup.exe`，包含 WebView2 离线安装器，默认安装到当前用户目录。安装包尚未签名。Windows 的构建、运行、性能与待人工验收项见 [Windows 验证报告](windows/docs/Windows验证报告.md)。Mac 本机交付使用 `交付/题库.app`（Apple Silicon，临时签名，尚未完成开发者签名与公证）。首次启动带有 914 题的「HarmonyOS 初级认证」发布题库。

`交付/` 是本机生成目录，不随 Git 克隆；从源码接手时请按下方开发命令构建。

- 两种模式统一搜索题干、选项、标签、章节和编号，不检索解析。空格分隔的词同时匹配；双引号表示连续短语。题干和选项中的命中词使用相同的多色高亮。极速模式遇到句尾命中时向前补足原文，不接回题干；多个词相距较远时用“…”连接命中片段，先保留全部搜索词，再填充上下文。极长搜索词超出整行宽度时可在题目区域横向滚动查看。`⌘K` / `Ctrl+K` 聚焦搜索。旧版题库首次打开会自动更新搜索索引，解析内容仍保留并可查看、导出。
- 顶部可切换「详细模式／极速模式」。极速模式只检索当前题库的全部题型，逐字搜索；左侧 80% 从命中位置展示题目片段，若后文不足一行，会按窗口宽度和字号向前补充上下文，右侧 20% 显示答案。一题一行，超出省略，向下滚动自动加载，列表没有翻页按钮。若从「全部题目」进入，优先采用当前题目所属题库。
- 详细模式的搜索结果与题目详情按 1:1 等宽显示，结果列表与极速模式共用连续滚动加载逻辑，靠近底部自动续载；不再有上一页、下一页、页码或每页数量提示。列表只渲染可见区域附近的题目，题干保留最多三行预览。顶部左侧按钮收起或展开侧栏；搜索区右下的「收起搜索区」将标题、搜索和筛选区域压缩为一行，点击「展开」恢复。两处收起／展开带有约 0.24 秒的过渡，遵循系统的“减少动态效果”设置。单行状态保留搜索、题型筛选、截图识题和新增题目入口，两处收起状态自动保存在本机。
- 极速模式顶部为左侧设置与「预览」开关、中间搜索框、右侧模式切换。开启预览后，鼠标进入题目行就立即显示完整题干、选项、答案和已有解析，移到另一行立即换题。预览按全文自动调整宽度和位置，不截断内容、不设置内部滚动条；移出列表或按 Esc 关闭，开关状态自动保存。
- 多词搜索按词使用不同的高亮颜色，同一个词在各题目中的所有出现位置颜色一致；详细模式也使用同一规则。重复的搜索词共用颜色，重叠命中按最靠前、同起点最长的片段展示。引号中的短语作为一个搜索词。
- 「设置与维护」提供小、中、大、超大四档字体；中号沿用原字号。松绿、海蓝、紫藤、暖杏、石墨、深色六种配色作用于整页；字号、配色、当前题库和页面模式自动保存在本机。
- 「截图识题」或搜索框右侧的扫描图标打开识题面板，应用内快捷键为 `⌘⇧O` / `Ctrl+Shift+O`。Mac 点击「截取屏幕」后，程序暂时隐藏，截取主屏幕；在返回的截图上拖动框选题目，松开后自动识别并查询当前题库。
- 直接在题库窗口按 `⌘V` / `Ctrl+V` 粘贴图片或完整题目，也会自动进入识题。普通短关键词仍用于搜索。面板内支持「粘贴识别」、选择 PNG / JPEG / WebP 文件、拖入图片，以及手工修改识别文字。
- OCR 默认优先使用系统能力，失败或没有文字时使用随程序打包的中英文引擎；也可手动选择内置引擎。无需单独安装 OCR 或下载模型。答案来自所选题库，选项换序时按内容重新对应字母；有错字或选项不一致时先展示候选，点击确认后查看答案。
- 每台客户端都能点击「制作离线包」，包括导入的只读题库。把 `.qbank.zip` 文件交给其他使用者，由对方在应用里导入。
- 发布题库保持只读。需要维护时点击「建立可编辑副本」，或新建自己的题库。副本具有独立身份，后续发布和更新应持续使用这一副本。
- 人工批量录题推荐 Excel：在「录题模板」下载模板，填写「题目」表；「示例」表不会自动导入。
- Word 采用每题一个固定字段表；JSONL 用于程序交换。导入均先预览，再一次性写入。旧版自由排版 Word 仅做此次迁移，后续使用标准模板。
- 已确认的答案差异直接更正，题目页面不额外显示冲突提示。依据保留在可展开的来源记录。尚无可靠结论的 3 题保留空答案，显示「待核对」。

新题须填写明确答案。单选选一个选项，多选至少两个；判断题填写正确或错误。删除题目后可在回收站恢复。

详细格式见 [导入格式与离线包规范](docs/导入格式与离线包规范_v1.md)，验证结果见 [Mac 本机验证报告](mac/docs/本机验证报告.md)。截图权限、识题限制及平台验证状态见 [截图识题实现与验证](docs/截图识题实现与验证.md)。

## 数据与发布

正常启动的数据目录由系统管理，可在「设置与维护」查看完整数据库路径。Mac 通常为 `~/Library/Application Support/local.questionbank.desktop/`。不要让多台电脑同时打开网盘中的 SQLite 文件；通过题库包交换发布内容。

离线包包含当前未删除题目的内容、答案、来源片段和修订号，不包含整个原始 Word 文件、回收站或完整编辑历史。它是发布快照，不是完整工作区备份。需要完整备份时退出应用，再复制设置中所示的整个数据目录。

收到同一题库的新版本后，导入会展示新增、变更和移除数量，校验完成后更新；同版本同内容重复导入会跳过。可在设置中回退最近一次导入，若导入后还有后续编辑，程序会阻止直接回退，保护这些修改。

## 开发与验证

常规环境需要 Node.js 22.18+（当前验证使用 24.19.0）、pnpm 11.25.0、稳定 Rust 与 Tauri 的平台依赖。Mac 需 Xcode Command Line Tools；Windows 构建需 MSVC 工具链与 WebView2。依赖版本以 `pnpm-lock.yaml` 和 `src-tauri/Cargo.lock` 为准。

以下命令均在仓库根目录执行。`pnpm tauri` 经由 `scripts/tauri.mjs` 自动合并本机平台的 `mac/tauri.conf.json` 或 `windows/tauri.conf.json`；传入 `--target` 时按目标平台选择。直接使用原生 Tauri CLI 时须显式传入对应的 `--config`，否则不会加载平台安装配置。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm tauri build --bundles app       # macOS
pnpm tauri build --bundles nsis      # Windows，须在 Windows 上执行
cargo test --manifest-path src-tauri/Cargo.toml --test core
cargo test --manifest-path src-tauri/Cargo.toml --test ocr
pnpm test:ui                       # Node.js 22.18+
pnpm test:platforms                # 平台配置与命令参数回归
```

本次工作区的 Rust 工具链安装在 `.tooling/`。Mac 可用 `sh mac/scripts/env.sh` 前缀执行 Cargo / Tauri；Windows 在 PowerShell 执行 `. .\windows\scripts\env.ps1` 后使用 Cargo / Tauri。桌面程序无需这些开发工具，Windows 安装后从快捷方式打开，Mac 直接打开 `.app`。

```sh
sh mac/scripts/env.sh pnpm tauri build --bundles app
sh mac/scripts/env.sh cargo test --manifest-path src-tauri/Cargo.toml --test core
sh mac/scripts/env.sh cargo build --release --manifest-path src-tauri/Cargo.toml --bin qbank-tool
src-tauri/target/release/qbank-tool inspect templates/题库导入模板_v1.docx
src-tauri/target/release/qbank-tool benchmark 100000 artifacts/new-bench.sqlite
src-tauri/target/release/qbank-tool remeasure artifacts/new-bench.sqlite
src-tauri/target/release/qbank-tool ocr tests/fixtures/ocr/true-false.png
src-tauri/target/release/qbank-tool benchmark-ocr artifacts/new-bench.sqlite --fuzzy
```

`qbank-tool benchmark` 拒绝覆盖已有数据库。它生成合成题与固定 200 个查询场景，保存核心检索报告。界面测量使用独立数据目录：把该数据库复制为目录中的 `question-bank.sqlite`，用 `QBANK_DATA_DIR` 指定目录并设置 `QBANK_BENCHMARK=1` 启动；设置页会出现验证入口。正式使用不需要开启此模式。

源代码按 `model`（数据约束）、`db`（存储与搜索）、`exchange`（导入导出）、Tauri 命令适配、React 界面分层。未来网页与小程序可沿用 JSONL / 发布包协议，仍需实现服务端传输和认证；当前没有在线服务。

OCR 的系统适配在 `mac/src/ocr.rs`、`mac/native/ocr_macos.m` 和 `windows/src/ocr.rs`，共享入口 `src-tauri/src/ocr/mod.rs` 按目标平台加载；题目解析、候选检索及答案对应仍在 `src-tauri/src/ocr/matching.rs`。前端入口在 `src/ocr-panel.tsx`，框选在 `src/ocr-crop.tsx`，内置识别器在 `src/ocr-client.ts`。构建前 `scripts/prepare-ocr.mjs` 校验本地模型并复制运行资源；模型版本、指纹与许可证位于 `assets/ocr/`。当前识别不会将截图上传至外部服务；后续可以添加在线服务，现阶段不需要账号或密钥。

## 当前范围

这是可运行的本机验证版，不代表已完成规划中的全部首版验收。Mac 已实际验证截图、图片粘贴、文字粘贴与答案匹配。Windows 已完成原生构建、NSIS 打包及真实 WebView2 功能检查，系统 OCR、内置离线 OCR、Windows 图片与文字剪贴板均已运行通过；安装生命周期结果和范围见 [Windows 验证报告](windows/docs/Windows验证报告.md)。系统截图框选、截图 Esc / 超时、多显示器和其他缩放比例仍需人工验证。签名公证、全局快捷键、托盘、单实例、导入取消与进度、权重排序和恢复演练仍需继续完成。微信小程序内置文字搜题版已实现、待真机验收；手机相机入口、复杂公式和题目图片附件按后续阶段实施。
