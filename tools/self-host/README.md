# Alpine 自托管 qbank-auth

这是题库唯一的服务端部署方式。服务运行在 SSH 管理的 Alpine 容器中，桌面端和小程序通过同一套 HTTPS API 访问；业务数据只写入本机 `/var/lib/qbank-auth`，运行时仅依赖 Node.js 内置模块。

## 运行边界

- SSH 端口 `8013` 只用于管理；应用默认绑定 `127.0.0.1:8080`。
- 对外访问需要反向代理提供 HTTPS，并把该域名加入微信小程序 `request` 合法域名；SSH 管理 IP 不能直接作为小程序 HTTPS 地址。
- `/var/lib/qbank-auth` 是唯一业务数据目录，部署前应完整备份。
- `QBANK_UPLOAD_ENABLED` 和 `QBANK_SYNC_ENABLED` 控制上传与合并；没有状态文件时目录可读但 revision 为 0。

## 本地构建和部署

```sh
pnpm build:self-host
pnpm self-host:deploy
```

生成 `artifacts/self-host/qbank-auth-0.2.7.tar.gz`。部署脚本通过 SSH/SCP 将服务包放到 `/opt/qbank-auth/releases/`，解压到带时间戳的目录，再原子切换 `/opt/qbank-auth/current`，不会覆盖正在运行的目录。

## 环境变量

将受限的环境文件放在 `/etc/qbank-auth/qbank-auth.env`，权限 `0600`，可从 [cloud/qbank-auth/.env.example](../../cloud/qbank-auth/.env.example) 复制模板。至少配置微信 AppID、AppSecret、会话密钥、题库目录、桌面维护者和最高权限账号，并增加：

```dotenv
QBANK_ENV_FILE=/etc/qbank-auth/qbank-auth.env
QBANK_STORAGE_ROOT=/var/lib/qbank-auth
QBANK_BIND_HOST=127.0.0.1
QBANK_PORT=8080
```

环境文件不纳入 Git，也不通过聊天传递。

## 初次种入题库

先备份存储目录，再执行一次：

```sh
node /opt/qbank-auth/current/seed-bank.cjs /var/lib/qbank-auth/import/questions.json
```

种入脚本遇到同题库已有状态会拒绝覆盖。种入之后依次核对 `GET /health`、`GET /v1/catalog`、题库 manifest 和快照摘要。

## 维护者密钥

在本机执行 `node tools/create-maintainer.mjs <维护者ID> <bank_id> <upload,merge> [https://服务地址]` 生成密钥、授权条目和桌面导入证书。只把授权条目写入服务器环境，把证书文件安全分发到对应桌面；私钥不写入代码或聊天。
