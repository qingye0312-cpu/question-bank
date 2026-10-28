# 云端源码

`cloud/qbank-auth/` 是题库自托管服务的唯一业务实现。它通过 HTTPS 为桌面端和微信小程序提供目录、快照、认证、维护者申请、授权、上传合并和修订回退。

运行数据不在仓库内：服务端由 `QBANK_STORAGE_ROOT` 指定目录，部署包只包含源码和运行所需的 Node 文件。

```sh
pnpm build:self-host
pnpm test:self-host
```

服务端变更先在 `cloud/qbank-auth/` 的路由/工作流测试中验证，再执行部署脚本。不要把环境文件、会话密钥、证书私钥或本机数据库加入 Git。
