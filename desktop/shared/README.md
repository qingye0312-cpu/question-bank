# 桌面共享层

这里是桌面端与微信小程序共同使用的 canonical source。

- `intake.ts`：题目解析、字段校验、摘要和增量包。
- `draft.ts`：本地草稿、修订和自动保存。
- `queue.ts`：上传任务、重试和失败状态。
- `codec.ts`、`gzip.ts`：压缩、编码和摘要。
- `sync.ts`：云端清单、纯题库文件和追加式修订流水校验。
- `appearance.ts`、`answer-presentation.ts`、`export-permission.ts`：跨端展示和权限规则。

修改后运行 `node scripts/sync-client-assets.mjs`；小程序 `core/` 中对应文件是生成副本，不要直接编辑。

当前协议使用 `question-file` 与 `operations-file` 两个独立对象。题库文件只承载当前正式题目；操作文件使用 `qbank-operations-2` 流水线：`question_index` 用于当前题目最后变更修订号，`revisions` 只追加新增、修改、删除三类题目 ID。桌面端在具备版本查看权限时缓存它，并据此重建版本历史、修订详情和导出范围。
