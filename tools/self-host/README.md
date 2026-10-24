# Alpine 自托管 qbank-auth

这是题库唯一的服务端部署方式。服务运行在 SSH 管理的 Alpine 容器中，桌面端和小程序通过同一套 HTTPS API 访问；业务数据只写入本机 `/var/lib/qbank-auth`，运行时仅依赖 Node.js 内置模块。

## 运行边界

- 公网 `8.141.124.97:8013` 同时提供 SSH 和 HTTPS。FRP 转到容器 `127.0.0.1:8444`，sslh 按协议分到 SSH `22` 或 Caddy `8443`；Caddy 反向代理到题库服务 `127.0.0.1:8080`。
- 桌面默认通过 `https://8.141.124.97:8013` 自动获取所有云端题库，使用内置 CA 公钥定向验证该服务。小程序仍需可信域名证书和微信 `request` 合法域名；当前等待域名配置，不能使用桌面的私有 CA 或直接照搬 IP 地址。
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

## HTTPS 与 SSH 共用端口

配置模板见 [Caddyfile](Caddyfile) 和 [sslh.conf](sslh.conf)。Alpine 安装 `caddy`、`sslh`、`openssl` 后，将模板分别安装到 `/etc/caddy/Caddyfile`、`/etc/sslh.conf`。先在回环端口验证两种协议，保留 FRP 配置备份和独立的定时恢复脚本，最后把现有 `remotePort = 8013` 对应的 `localPort` 从 `22` 改为 `8444`。只有公网 HTTPS 验证和新 SSH 登录都成功，才取消恢复任务；不直接关闭 SSH 监听。

Caddy 使用内部 CA 自动签发、续期 IP 证书。公开根证书通过已验证的 SSH 连接取得，保存于 [qbank-pve-root-ca.pem](../../src-tauri/resources/qbank-pve-root-ca.pem)，随桌面编译；只对 [desktop-service.json](../../shared/desktop-service.json) 的完整 HTTPS origin 生效，其他 origin 使用系统信任。客户端仍校验 IP、证书有效期和签发链，不安装全局根证书，不允许跳过 TLS 校验。

根和中间证书私钥留在服务器 `/var/lib/caddy/.local/share/caddy/pki/`，必须与业务数据一起备份，禁止放入代码或客户端。叶子证书自动续期无需更新客户端；更换根 CA 时需要重新分发包含新公钥的桌面版。Caddy 管理接口仅监听回环 `2019`。

```sh
curl --cacert src-tauri/resources/qbank-pve-root-ca.pem https://8.141.124.97:8013/health
sh mac/scripts/env.sh cargo test --manifest-path src-tauri/Cargo.toml --test cloud_live -- --ignored --nocapture
```

第二条命令只读访问真实服务，将目录内所有题库应用到隔离临时数据库，核对题数和幂等，不写入日常数据库或远端题库。普通浏览器尚未信任这份私有 CA，小程序的域名及公开证书接入需要另行完成。[Caddy 内部证书说明](https://caddyserver.com/docs/automatic-https#local-https)、[sslh 协议分流说明](https://github.com/yrutschle/sslh)。

## 初次种入题库

先备份存储目录，再执行一次：

```sh
node /opt/qbank-auth/current/seed-bank.cjs /var/lib/qbank-auth/import/questions.json
```

种入脚本遇到同题库已有状态会拒绝覆盖。种入之后依次核对 `GET /health`、`GET /v1/catalog`、题库 manifest 和快照摘要。

## 题目质量状态修复

`repair-bank-status.cjs` 仅处理“没有答案且带问题说明，却被标为已核实”的矛盾数据。执行前备份数据，再以 `qbank` 用户运行：

```sh
su qbank -s /bin/sh -c 'node /opt/qbank-auth/current/repair-bank-status.cjs <bank_id> /var/lib/qbank-auth'
```

工具只把符合条件的题目状态改为 `needs_review`，不修改题干、选项或答案，不猜测答案。修复记录包含时间、题目 ID 和前后修订，保存为新的不可变版本；其他数据错误会中止写入，重复执行无变化时不增加版本。

## 维护者密钥

在本机执行 `node tools/create-maintainer.mjs <维护者ID> <bank_id> <upload,merge> [https://服务地址]` 生成密钥、授权条目和桌面导入证书。只把授权条目写入服务器环境，把证书文件安全分发到对应桌面；私钥不写入代码或聊天。
