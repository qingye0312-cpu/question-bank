# tools

工具按交付边界分组：

- `desktop-release/`：桌面版本校验、更新器配置、清单和校验和。
- `macos/`：macOS 本地签名/构建发布流程。
- `mobile-index/`：从题库源文件生成小程序索引和数据包。
- `self-host/`：自托管部署、下载页、更新源和只读诊断。
- `encode-upload.mjs`：将标准题目增量编码为云端上传包。

工具输出写入 `build/`、`artifacts/` 或系统临时目录；不要把凭据、服务端环境文件或大体积运行证据写入源码目录。
