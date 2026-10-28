# Tauri / Rust 层

`src-tauri/` 提供桌面本机能力：SQLite 数据库和 FTS 索引、云端快照应用、录题草稿、文件交换、备份恢复、OCR、托盘和更新器。

- `src/commands/`：前端 IPC 命令入口。
- `src/db.rs`、`src/library.rs`、`src/model.rs`：题库、索引和数据模型。
- `src/cloud/`、`src/cloud.rs`：云端传输、压缩快照和正式缓存。
- `src/intake.rs`、`src/drafts.rs`：录题和待上传临时保存。
- `src/exchange/`：导入、导出和离线包。
- `src/ocr/`：调用 `mac/` 或 `windows/` 的原生识别实现。

平台配置由根目录 `mac/tauri.conf.json`、`windows/tauri.conf.json` 合并。`target/`、`gen/` 和临时前端文件都是可重建产物，不纳入 Git。
