# 桌面共享层

这里是桌面端与微信小程序共同使用的 canonical source。

- `intake.ts`：题目解析、字段校验、摘要和增量包。
- `draft.ts`：本地草稿、修订和自动保存。
- `queue.ts`：上传任务、重试和失败状态。
- `codec.ts`、`gzip.ts`：压缩、编码和摘要。
- `sync.ts`：云端清单、快照和缓存校验。
- `appearance.ts`、`answer-presentation.ts`、`export-permission.ts`：跨端展示和权限规则。

修改后运行 `node scripts/sync-client-assets.mjs`；小程序 `core/` 中对应文件是生成副本，不要直接编辑。
