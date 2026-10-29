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
| `operations.cjs` | 独立的逐修订、逐题操作记录文件 |
| `codec.cjs`、`fs-store.cjs` | 压缩、摘要和不可变文件存储 |

生产数据目录由 `QBANK_STORAGE_ROOT` 指定。每次首版、上传合并或回退都会写入新的完整状态文件；回退不再写指针，因而后续正式上传不会继承回退标记。同步协议提供两个压缩文件：

- `/v1/banks/:id/question-file`：纯题库内容和必要的版本身份信息；
- `/v1/banks/:id/operations-file`：需要题库版本查看权限，提供逐修订、逐题的上传时间、上传者、进入版本、修订动作和历史版本映射。

桌面端按清单摘要校验两个文件，将题库内容写入本地搜索库，把操作文件缓存到本机；按修订导出时从最新正式题库读取记录范围内的题目。旧 `/snapshot-file` 接口保留给旧客户端兼容。回退正式版本时，桌面端依据新题库文件中的 `rollback_of` 清除对应导入包指纹，但不会清理待上传草稿。账号会话按平台绑定：同一账号最多一个桌面会话和一个小程序会话。
