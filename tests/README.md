# tests

测试按跨层边界组织：

- `intake.test.mjs`、`draft-codec.test.mjs`：共享题目协议、草稿、压缩和队列。
- `desktop-cloud.test.mjs`、`appearance.test.mjs`、`search-presentation.test.mjs`、`ocr-client.test.mjs`：桌面逻辑和展示。
- `cloud-auth.test.mjs`、`cloud-workflow.test.mjs`、`password-maintainer.test.mjs`、`self-host.test.mjs`：云端认证、合并、回退、上传和部署协议。
- `miniprogram*.test.mjs`：小程序生成副本、服务和索引。
- `platform-build.test.mjs`：平台配置合并、图标、NSIS 和 Tauri 参数。

测试应验证边界行为，而不是复制实现细节。修改路径或生成关系后，先运行平台和同步检查，再运行对应功能套件。
