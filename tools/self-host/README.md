# Alpine 自托管 qbank-auth

该目录把腾讯云 SCF 的 `qbank-auth` HTTP 契约运行在 Alpine 容器中。`local-server.cjs` 复用原认证、上传、合并和快照逻辑，`fs-store.cjs` 将 COS 的 `inbox/` 与 `states/` 前缀映射为本地不可变文件。部署包不包含 AppSecret、维护密钥、微信 openid 或腾讯云凭据。

## 运行边界

- SSH 端口 `8013` 只用于管理；应用默认绑定 `127.0.0.1:8080`。
- 微信小程序生产版仍需一个已备案的 HTTPS 域名，不能把管理 IP 当作 `request` 合法域名。
- `/var/lib/qbank-auth` 是唯一业务数据目录，首次迁移前应完整备份。
- `QBANK_UPLOAD_ENABLED` 和 `QBANK_SYNC_ENABLED` 仍由环境变量控制；没有状态文件时目录可读但 revision 为 0。

## 本地构建

```sh
pnpm build:cloud
pnpm build:self-host
```

生成 `artifacts/self-host/qbank-auth-0.2.7.tar.gz`。通过 SSH/SCP 复制到 `/opt/qbank-auth/releases/`，解压到带时间戳的目录，再把 `current` 原子切换过去。不要直接覆盖正在运行的目录。

## 环境变量

将受限的环境文件放在 `/etc/qbank-auth/qbank-auth.env`，权限 `0600`，至少包含 `.env.example` 中的认证、题库目录和授权项，并增加：

```dotenv
QBANK_ENV_FILE=/etc/qbank-auth/qbank-auth.env
QBANK_STORAGE_ROOT=/var/lib/qbank-auth
QBANK_BIND_HOST=127.0.0.1
QBANK_PORT=8080
```

`local-server.cjs` 先读取环境文件，再由进程环境覆盖；环境文件不纳入 Git，不通过聊天传递。

## 初次种入题库

先备份存储目录，再执行一次：

```sh
node /opt/qbank-auth/current/seed-bank.cjs /opt/qbank-auth/import/questions.json
```

种入脚本遇到同题库已有状态会拒绝覆盖。题库来源应是已核对的 `qbank-bank-json` 或内置 `questions.json`，种入之后再通过 `/health`、`/v1/catalog` 和快照摘要核对。
