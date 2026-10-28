# 项目数据

这里仅保留需要和代码一起维护的数据输入，不放运行日志、数据库、密钥或模型输出。

- [`formal-history/`](formal-history/)：题库正式历史版本的原始资料归档。文件按原始版本保留，不参与桌面构建。
- `tools/mobile-index/sources/`：当前小程序索引的规范 JSONL 输入。
- `miniprogram/miniprogram/data/`：由索引脚本生成并随小程序发布的当前数据。
- `desktop/src-tauri/resources/`：桌面运行时的种子、示例和服务信任根。

正式历史归档只追加或修订说明，不用来保存开发过程中的临时导出。任何需要删除正式版本的操作都必须先确认云端不可变历史仍有完整副本。
