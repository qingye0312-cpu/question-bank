# qbank-auth

Node.js 内置模块实现的自托管 HTTP 服务。

| 文件 | 职责 |
| --- | --- |
| `local-server.cjs` | 本机监听和启动入口 |
| `service.cjs` | HTTP 路由分发 |
| `auth.cjs`、`access.cjs`、`password.cjs` | 会话、权限、手机号和密码 |
| `submission.cjs` | 上传包校验、去重和批次 |
| `workflow.cjs` | 合并、正式发布和每次完整修订提交 |
| `catalog.cjs`、`projection.cjs` | 目录、清单和题库文件投影 |
| `operations.cjs` | 当前题目索引和追加式修订流水的生成、迁移与追加 |
| `codec.cjs`、`fs-store.cjs` | 压缩、摘要和不可变文件存储 |

生产数据目录由 `QBANK_STORAGE_ROOT` 指定。每次首版、上传合并或回退都会写入新的完整状态文件；回退不再写指针，因而后续正式上传不会继承回退标记。每个题库同时维护 `operations/<bank_id>/pipeline.json`，它是可原子替换的流水线侧车，不再在每次请求时遍历全部历史状态重建操作记录。流水线包含两部分：

- `question_index`：当前正式题目 ID 到最后一次变更修订号的索引。题目新增或恢复时写入，题目修改时更新，题目删除时移除；只保留当前正式题目。
- `revisions`：只追加的修订记录。每条记录写入修订号、操作人、操作时间、备注，以及 `added`、`revised`、`removed` 三组题目 ID 和对应数量。

已有题库首次切换时，先运行 `tools/self-host/migrate-operation-pipeline.cjs`，它只为每个没有侧车的题库生成一条“历史题库初始化记录”，把当前全部正式题目作为 `added`，之后不再重写这条历史记录。服务端也保留惰性兜底：首次读取缺失侧车时会生成同一条初始化记录。

同步协议提供两个压缩文件：

- `/v1/banks/:id/question-file`：纯题库内容和必要的版本身份信息；
- `/v1/banks/:id/operations-file`：需要题库版本查看权限，提供 `qbank-operations-2` 流水线；旧的 `qbank-operations-1` 仍可被兼容读取。

桌面端按清单摘要校验两个文件，将题库内容写入本地搜索库，把操作文件缓存到本机；按修订导出时从最新正式题库读取记录范围内的题目。旧 `/snapshot-file` 接口保留给旧客户端兼容。回退正式版本时，桌面端依据新题库文件中的 `rollback_of` 清除对应导入包指纹，但不会清理待上传草稿。账号会话按平台绑定：同一账号最多一个桌面会话和一个小程序会话。
