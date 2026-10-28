# qbank-auth

Node.js 内置模块实现的自托管 HTTP 服务。

| 文件 | 职责 |
| --- | --- |
| `local-server.cjs` | 本机监听和启动入口 |
| `service.cjs` | HTTP 路由分发 |
| `auth.cjs`、`access.cjs`、`password.cjs` | 会话、权限、手机号和密码 |
| `submission.cjs` | 上传包校验、去重和批次 |
| `workflow.cjs` | 合并、正式发布、修订、回退和操作记录 |
| `catalog.cjs`、`projection.cjs` | 目录、清单和快照投影 |
| `codec.cjs`、`fs-store.cjs` | 压缩、摘要和不可变文件存储 |

生产数据目录由 `QBANK_STORAGE_ROOT` 指定。回退正式版本时，工作流必须同步删除对应导入包指纹；这保证重新上传回退题目不会被旧指纹错误拦截。账号会话按平台绑定：同一账号最多一个桌面会话和一个小程序会话。
